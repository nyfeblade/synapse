import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation
import IOKit
import Speech

// JSON-lines speech helper for dictation and voice mode (CHAT-08). One recognition path for every
// audio source: buffers (microphone tap, or an audio FILE in self-test mode) → 16 kHz mono →
// voice-activity detection → one on-device recognition task per utterance → end-of-turn on silence.
//
// stdout: one JSON event per line —
//   ready {source, mode, onDevice}      the source started
//   audio {source, sampleRate, channels} the first buffer actually arrived (the microphone is live)
//   speech-start                        VAD heard someone start talking (a new utterance)
//   speech-drop                         (call mode) that utterance ended with no words and no final
//   partial {text} / final {text}       live and end-of-turn transcripts
//   barge-in                            the user talked over the Bot's speech; playback stopped
//   likely-end {text}                   bug 142 (call mode): the utterance is probably complete; the final follows
//   speak-start {id, voice} / speak-end {id, interrupted}
//   audio-restart {reason}              the audio engine stopped by itself and was restarted
//   error {code, message} / end
// stderr: human-readable diagnostics, "[bots-dictation +<ms>] …" (the app keeps the tail).
//   devices {input, output, echoCancellation} the devices the audio path really uses (bug 105)
//   device-fallback {kind, uid, name, fallback} / device-restored {kind, uid, name}
//   echo-unavailable {reason}           voice processing wouldn't run with these devices; no echo cancellation
// stdin: stop | hush | mute | unmute | speak {…} | devices {"input","output"} | context {"strings":[…]}
//   Bug 162: --context-file PATH (a JSON array, or {"strings":[…]}) biases the recognizer towards the
//   user's Bot names, contacts, project terms and recent chat words — the single biggest accuracy win
//   on names. `context {json}` on stdin replaces the list mid-session (a new Bot, another chat).
//   --build-lm --lm-dir DIR --context-file F compiles a custom language model from those names and
//   exits ({"type":"lm"}); --lm-dir DIR on a session recognises against it. Built once and cached by
//   the app, rebuilt only when the names change. A missing or half-built model is simply not used.
//   --self-test-text checks the spoken-command and post-correction rules without Speech access.
//
//   Bug 165: --whisper-model PATH re-transcribes each finished utterance with whisper.cpp (Metal),
//   with the same vocabulary as its initial prompt. Apple still drives the partials and the end of
//   turn; whisper's text becomes the `final` unless it misses --whisper-budget-ms (default 800; the
//   app passes 900) or comes back implausible, in which case Apple's text stands and the reason is
//   logged. The `final` carries {engine, whisperMs}. NO --whisper-model = no load, no memory, no
//   PCM kept — which is exactly what Settings → Voice's Light mode passes. --no-whisper-prompt,
//   --whisper-beam, --whisper-audio-ctx and --whisper-bench FILE exist for the accuracy sweep.
//   Measured on 60 clips: Apple alone 12.0% WER / 96 of 102 names, hybrid 10.5% / 101; on bug 162's
//   own 36, 8.1% → 4.7% and 51/54 → 54/54. Added p50 461 ms, p90 473 ms; model load 247 ms.
//   The libraries come from app/native/whisper/install.sh and are linked by build.sh ONLY when they
//   are there; without them this helper has no whisper in it and behaves exactly as it did before.
//
//   Bug 185: an entire speech, however long. Dictation no longer ends at its first pause: each
//   pause closes a sentence (its final goes out, in order) and dictation stops on `stop` or after
//   --idle-stop-ms (default 10 s) with no new words. Apple's text survives the recognizer starting
//   over after a pause; a turn longer than ~28 s goes to whisper in chunks cut between words while
//   the user is still talking; the budget grows with the audio (base + 60 ms/s past 5 s, max 6 s).
//   Measured before → after, dictation: 45 s 32.7% → 0% WER, 90 s 31.3% → 0%, 3 min 89.3% → 0.3%.
//
// On the engine (measured 2026-09-22, 36 synthesised clips, this Mac, macOS 27 / SDK 26.5):
// SFSpeechRecognizer is still the best of the three. SpeechTranscriber IGNORES contextual strings
// (identical output with and without), and DictationTranscriber honours them but reaches exactly the
// same accuracy as SFSpeechRecognizer for ~3x the CPU and a slower first partial. So the modern
// stack is used where it genuinely wins — SFCustomLanguageModelData, which the old request accepts
// too — and the recognizer itself stays SFSpeechRecognizer.
//   Bug 107: speak {…, "engine":"pcm"} opens a line whose audio arrives as Kokoro PCM (24 kHz mono
//   float32 LE, base64): pcm {"id","data"} per chunk, then pcm-end {"id"}; pcm-fail {"id"} says the
//   line with Apple's voice instead (if none of it has played). Same player, same FIFO, same barge-in.
//   --pcm-stdin (with --test-speaker): Preview plays PCM fed the same way.
//   Bug 134: speak {…, "pan": -1…1} places a line in the stereo field (group calls: each Bot's seat);
//   spatial on | spatial off rebuilds the output in stereo / mono mid-call (on only works if the
//   voice-processing unit starts with a stereo output; otherwise spatial-unavailable {reason} and mono);
//   fx {"data"} plays a short sound (24 kHz mono float32 LE, base64: the join / leave chime) through the
//   same mixer, so echo cancellation hears it too — never through the speech queue.
//   Bug 213: a call is stereo from its start (mono only on a mono output), so a Bot joining never
//   rebuilds the path. speak {…, "azimuth": degrees, "seat": botId} puts a group call's line at its
//   Bot's seat: on headphones a real binaural seat (one HRTFHQ player per Bot into an environment
//   node, loudness-matched to the centred voice), on speakers today's gentle pan, on a mono / unknown
//   output centred. route {mode, stereo, output, transport, channels} says which, and follows the
//   output mid-call (the jack's data source, a Bluetooth profile switch, a new default device).
//   mic-choice {input, instead, reason} — the Mac's microphone was opened instead of a Bluetooth
//   headset's own, which would have dropped the headset to mono hands-free (input null: back to the
//   usual one). --spatial-route auto|headphones|speakers|off overrides the route's placement.
//   --self-test-spatial [--speech a,b,c] [--out DIR] measures the graph offline (nothing plays).
//   --phrase TEXT (with --test-speaker): what the Apple fallback says (a voicemail); --max-seconds N.
//   Bug 198: --remote-audio (with --mode call) is a call placed from the user's phone. This Mac's
//   microphone and speaker are never opened (no microphone permission is asked for): `mic <base64>`
//   stdin lines carry the phone's microphone (16-bit LE, 16 kHz mono) and the call's output is written
//   as `{"type":"out","data":<base64>}` lines (16-bit LE, 24 kHz mono, real-time pace) for the phone.
// --mode wake --names "Nova,Atlas" [--wake-threshold 0.3]: listens for "Hey <name>" (on-device only).
//   Emits nothing it hears — no speech-start, partial or final — only wake {name, confidence, ms, also?}
//   ("Hey Nova and Scout": also = ["Scout"], bug 213) and
//   wake-rejected {name, confidence} (below the threshold). stdin: stop | names {"names":[…]} | devices.
//   --self-test-wake checks the matcher and the confidence rule without Speech access.
//
// Other modes (bug 105), none of which needs Speech access:
//   --list-devices       one line: {"type":"devices","devices":[{uid,name,input,output,transport,defaultInput,defaultOutput}]}
//   --meter              input level of the chosen microphone: level {db} ~10/s until stdin closes / "stop"
//   --test-speaker       speaks one short phrase through the chosen output, then exits
//   --dry-run            (with --meter / --test-speaker) resolve the devices, report them, exit; nothing plays
//   --self-test-devices  the device selection / fallback / restore logic checks itself
//   --list-voices        one line: {"type":"voices","voices":[{id,name,lang,quality,siri,personal}]}, best first (bug 106)
//   --voice ID|NAME      the voice for replies / the speaker test; a name means that name's best-quality voice
//   --self-test-voice    the voice ranking, end-of-turn and barge-in logic checks itself (bug 106)
//   --input-device UID / --output-device UID  the CoreAudio device to use instead of the system default
//
// Bug 101: macOS stops an AVAudioEngine by itself right after it starts ("iounit configuration
// changed > stopping the engine" — the default-device aggregate is rebuilt as input starts), then
// posts AVAudioEngineConfigurationChange. The old helper never listened for it, so the engine sat
// stopped, not one buffer reached the recognizer, and the session ended as "No speech detected",
// which the app treated as an ordinary quiet end. Now a configuration change reinstalls the tap and
// restarts the engine, a watchdog restarts a source that stops delivering audio, and a source that
// can't be revived ends with a reason (code "no-audio") instead of silence.

setvbuf(stdout, nil, _IOLBF, 0)
let outLock = NSLock()
func emit(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
  outLock.lock(); print(s); fflush(stdout); outLock.unlock()
}
let t0 = DispatchTime.now().uptimeNanoseconds
func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000 }
func log(_ s: String) {
  FileHandle.standardError.write("[bots-dictation +\(Int(nowMs()))ms] \(s)\n".data(using: .utf8)!)
}

enum Mode: String { case dictation, call, wake }
struct Options {
  var locale = Locale.current.identifier
  var mode = Mode.dictation
  var file: String? = nil
  /// 0.1.4: the user opted in to Apple's servers for speech when this Mac can't recognise it on its own.
  var allowServer = false
  var silenceMs = 1200.0
  var noSpeechMs = 8000.0
  /// Bug 185: dictation keeps listening through pauses and stops after this long with no new words.
  var idleStopMs = 10000.0
  var voiceProcessing = false
  var simulate: String? = nil
  var inputDevice: String? = nil
  var outputDevice: String? = nil
  var listDevices = false
  var meter = false
  var testSpeaker = false
  var dryRun = false
  var selfTestDevices = false
  /// Bug 106: the voice the app chose in Settings → Voice (an identifier or a name); nil = the best installed.
  var voice: String? = nil
  var listVoices = false
  var selfTestVoice = false
  /// Bug 141: speech survives an audio-path restart (an offline engine; no device, no Speech access).
  var selfTestPlayback = false
  /// Bug 213: the spatial call graph (offline, nothing plays) measures itself; --speech / --out for the report.
  var selfTestSpatial = false
  /// Bug 107: the speaker test plays Kokoro PCM fed on stdin (pcm / pcm-end / pcm-fail) instead of Apple's voice.
  var pcmStdin = false
  /// Wake word: the Bot names "Hey <name>" listens for (--names "Nova,Atlas"; `names {json}` on stdin replaces them).
  var names: [String] = []
  /// Wake word: the lowest recognizer confidence (min over "hey" and the name's words) that fires.
  var wakeThreshold = 0.3
  var selfTestWake = false
  /// Bug 162: the spoken-command and post-correction rules check themselves (no Speech access).
  var selfTestText = false
  /// Bug 162: the names and terms this session biases the recognizer towards, longest first.
  var context: [String] = []
  /// Bug 162: a compiled custom language model built from the user's own vocabulary (--build-lm).
  var lmDir: String? = nil
  var buildLM = false
  /// Bug 134: the speaker test's Apple phrase (a voicemail's words), and how long it may play.
  var phrase: String? = nil
  var maxSeconds = 15.0
  /// Bug 165: the whisper.cpp model that re-transcribes each finished utterance. Absent = whisper
  /// never loads and never runs, which is what Settings → Voice's Light mode passes.
  var whisperModel: String? = nil
  /// How long whisper may take before the turn falls back to Apple's text (measured, see bug 165).
  var whisperBudgetMs = WhisperLimit.defaultBudgetMs
  /// Whether whisper gets the session's vocabulary as its initial prompt (--no-whisper-prompt: off).
  var whisperPrompt = true
  /// Beam width; 1 = greedy. Greedy is what ships — the sweep found beams cost time for no accuracy.
  var whisperBeam = 1
  /// 0 = scale the encoder window to the utterance (the default); a fixed value is for the sweep.
  var whisperAudioCtx: Int32 = 0
  /// Bug 165: transcribe one WAV with whisper and exit — the accuracy sweep, no Speech, no microphone.
  var whisperBench: String? = nil
  /// Bug 198: a call from the user's phone. The microphone is the phone's (`mic` lines on stdin) and the
  /// Bot's voice goes back to it (`out` lines on stdout); this Mac's own microphone and speaker stay off.
  var remoteAudio = false
  /// Bug 213: how a call's voices are placed — auto (from the output device), headphones, speakers or off (centred).
  var spatialRoute: String? = nil
  /// Bug 213: the call is a group call at its start: build the output in stereo with the seats from the
  /// start. A 1:1 call is left exactly as before (mono, voice processing) until a second Bot joins.
  var spatialAtStart = false
}
var opt = Options()
var argv = CommandLine.arguments.dropFirst().makeIterator()
while let a = argv.next() {
  switch a {
  case "--locale": if let v = argv.next(), !v.isEmpty { opt.locale = v }
  case "--mode": if let v = argv.next(), let m = Mode(rawValue: v) { opt.mode = m }
  case "--file", "--self-test": opt.file = argv.next()
  case "--silence-ms": if let v = argv.next(), let n = Double(v), n >= 300, n <= 5000 { opt.silenceMs = n }
  case "--no-speech-ms": if let v = argv.next(), let n = Double(v), n >= 1000, n <= 60000 { opt.noSpeechMs = n }
  case "--idle-stop-ms": if let v = argv.next(), let n = Double(v), n >= 2000, n <= 600000 { opt.idleStopMs = n }
  case "--voice-processing": opt.voiceProcessing = true
  case "--simulate": opt.simulate = argv.next()
  case "--input-device": if let v = argv.next(), !v.isEmpty { opt.inputDevice = v }
  case "--output-device": if let v = argv.next(), !v.isEmpty { opt.outputDevice = v }
  case "--list-devices": opt.listDevices = true
  case "--meter": opt.meter = true
  case "--test-speaker": opt.testSpeaker = true
  case "--dry-run": opt.dryRun = true
  case "--self-test-devices": opt.selfTestDevices = true
  case "--voice": if let v = argv.next(), !v.isEmpty { opt.voice = v }
  case "--list-voices": opt.listVoices = true
  case "--self-test-voice": opt.selfTestVoice = true
  case "--self-test-playback": opt.selfTestPlayback = true
  case "--self-test-spatial": opt.selfTestSpatial = true
  case "--speech", "--out", "--seat-mode": _ = argv.next() // read by --self-test-spatial itself
  case "--pcm-stdin": opt.pcmStdin = true
  case "--allow-server-speech": opt.allowServer = true
  case "--names": if let v = argv.next() { opt.names = cleanNames(v.split(separator: ",").map(String.init)) }
  case "--wake-threshold": if let v = argv.next(), let n = Double(v), n >= 0, n <= 1 { opt.wakeThreshold = n }
  case "--self-test-wake": opt.selfTestWake = true
  case "--self-test-text": opt.selfTestText = true
  case "--lm-dir": if let v = argv.next(), !v.isEmpty { opt.lmDir = v }
  case "--build-lm": opt.buildLM = true
  // Bug 162: a file, not argv — the list runs to hundreds of names and argv has a size limit.
  case "--context-file": if let v = argv.next() { opt.context = readContextFile(v) }
  case "--phrase": if let v = argv.next(), !v.isEmpty { opt.phrase = String(v.prefix(600)) }
  case "--max-seconds": if let v = argv.next(), let n = Double(v), n >= 5, n <= 120 { opt.maxSeconds = n }
  // Bug 165: whisper.cpp. No --whisper-model, no whisper — nothing is loaded and nothing runs.
  case "--whisper-model": if let v = argv.next(), !v.isEmpty { opt.whisperModel = v }
  case "--whisper-budget-ms": if let v = argv.next(), let n = Double(v), n >= 100, n <= 10000 { opt.whisperBudgetMs = n }
  case "--no-whisper-prompt": opt.whisperPrompt = false
  case "--whisper-beam": if let v = argv.next(), let n = Int(v), n >= 1, n <= 8 { opt.whisperBeam = n }
  case "--whisper-audio-ctx": if let v = argv.next(), let n = Int32(v), n >= 0, n <= 1500 { opt.whisperAudioCtx = n }
  case "--whisper-bench": opt.whisperBench = argv.next()
  case "--remote-audio": opt.remoteAudio = true
  case "--spatial": opt.spatialAtStart = true
  case "--spatial-route": if let v = argv.next(), ["auto", "headphones", "speakers", "off"].contains(v) { opt.spatialRoute = v == "auto" ? nil : v }
  default: log("ignoring unknown argument \(a)")
  }
}
log("start mode=\(opt.mode.rawValue) locale=\(opt.locale) source=\(opt.file != nil ? "file" : opt.remoteAudio ? "remote" : "mic") voiceProcessing=\(opt.voiceProcessing) silenceMs=\(Int(opt.silenceMs)) input=\(opt.inputDevice ?? "default") output=\(opt.outputDevice ?? "default") voice=\(opt.voice ?? "auto")")
let q = DispatchQueue(label: "bots-dictation.pipeline")
/// Bug 141: how long a (re)started call engine must stay up before speech is scheduled on it. The field
/// logs show the voice-processing configuration change landing 0–120 ms after the first start.
let LIMIT_PATH_SETTLE_MS = 300.0

/// Bug 165: leave without running the C++ static destructors. ggml's Metal backend tears its device
/// down from a global destructor during `exit()`, and on this build that abort()s — the helper would
/// die with SIGABRT AFTER it had already said `end`, and the app reports a signal exit as a crash
/// ("The dictation helper stopped unexpectedly"). stdout is line-buffered and every `emit` flushes,
/// so there is nothing left to lose by skipping them.
func leave(_ status: Int32) -> Never {
  fflush(stdout)
  fflush(stderr)
  _exit(status)
}

/// Every exit says why (bug 96/99/101): an `error` with a code the app maps to words, then `end`.
func fail(_ code: String, _ message: String, _ status: Int32) -> Never {
  log("fail \(code): \(message)")
  emit(["type": "error", "code": code, "message": message]); emit(["type": "end"]); leave(status)
}

// ---------- the device modes (bug 105): no Speech access needed, so they run before it is checked ----------
if opt.selfTestDevices { runDeviceSelfTest() }
if opt.selfTestVoice { runVoiceSelfTest() }
if opt.selfTestPlayback { runPlaybackSelfTest() }
if opt.selfTestSpatial { runSpatialSelfTest() }
if opt.selfTestWake { runWakeSelfTest() }
if opt.selfTestText { runTextSelfTest() }
if opt.buildLM { runBuildLM() }
if opt.whisperBench != nil { runWhisperBench() }
if opt.listVoices { runListVoices() }
if opt.listDevices { runListDevices() }
if opt.meter { runMeter() }
if opt.testSpeaker { runSpeakerTest() }

// ---------- permissions (bug 96/99) ----------
func speechStatus() -> SFSpeechRecognizerAuthorizationStatus {
  var status = SFSpeechRecognizer.authorizationStatus()
  if status == .notDetermined {
    let sem = DispatchSemaphore(value: 0)
    SFSpeechRecognizer.requestAuthorization { s in status = s; sem.signal() }
    sem.wait()
  }
  return status
}
switch speechStatus() {
case .authorized: break
case .restricted: fail("permission", "permission:speech:restricted", 2)
default: fail("permission", "permission:speech:denied", 2)
}
func requireMicPermission() {
  var mic = AVCaptureDevice.authorizationStatus(for: .audio)
  if mic == .notDetermined {
    let sem = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { ok in mic = ok ? .authorized : .denied; sem.signal() }
    sem.wait()
  }
  switch mic {
  case .authorized: break
  case .restricted: fail("permission", "permission:microphone:restricted", 2)
  default: fail("permission", "permission:microphone:denied", 2)
  }
}
// Bug 198: a phone call never opens this Mac's microphone, so it never asks for it either.
if opt.file == nil && !opt.remoteAudio { requireMicPermission() }

let recognizer: SFSpeechRecognizer = {
  guard let r = SFSpeechRecognizer(locale: Locale(identifier: opt.locale)) else {
    fail("recognizer-unavailable", "Speech recognition doesn't support this language (\(opt.locale)).", 3)
  }
  return r
}()
guard recognizer.isAvailable else {
  fail("recognizer-unavailable", "Speech recognition isn't available right now. Check that Siri & Dictation's language is installed.", 3)
}
let recognizerQueue = OperationQueue()
recognizerQueue.underlyingQueue = q
recognizerQueue.maxConcurrentOperationCount = 1
recognizer.queue = recognizerQueue
let onDevice = recognizer.supportsOnDeviceRecognition
log("recognizer ready, onDevice=\(onDevice)")
// Wake word: local only. A recognizer that would send audio to a server never listens for the name.
if opt.mode == .wake && !onDevice {
  fail("offline-unavailable", "Listening for \"Hey <name>\" needs on-device speech recognition for \(opt.locale). Download the language in System Settings → Keyboard → Dictation.", 3)
}
// 0.1.4 first-run: dictation and calls never send speech to Apple's servers silently. Without on-device recognition
// for this language the helper stops before any audio is captured, and the app asks once (the user's opt-in comes
// back as --allow-server-speech). A --file self-test is the developer's own audio, not the user's speech.
if !onDevice && !opt.allowServer && opt.file == nil {
  fail("server-speech", "This Mac can't recognise \(opt.locale) speech on its own. Allow Apple's servers, or download the language in System Settings → Keyboard → Dictation.", 3)
}
/// Wake word: the names being listened for (only touched on q).
var wakeNames = opt.names
/// Bug 162: the names and terms this session biases the recognizer towards, and the subset that
/// post-correction may restore. Replaced mid-session by a `context {json}` line on stdin, so a new
/// Bot or a freshly opened chat is heard correctly without restarting the helper. Only touched on q.
var sessionContext = opt.context
/// Bug 162: the compiled custom language model to recognise against, once it is known to be there.
/// A half-built or missing model is simply not used — the session still has its contextual strings.
let lmDirInUse: String? = {
  guard let dir = opt.lmDir else { return nil }
  let fm = FileManager.default
  for f in ["model.lm", "model.vocab"] where !fm.fileExists(atPath: (dir as NSString).appendingPathComponent(f)) {
    log("custom language model incomplete (\(f) missing); using contextual strings only")
    return nil
  }
  log("custom language model: \(dir)")
  return dir
}()
/// Bug 165: whisper.cpp, loading in the background from this moment so the first end-of-turn finds
/// it ready. Nil in Settings → Voice's Light mode, which passes no --whisper-model at all: nothing
/// is read from disk and nothing is held in memory. Wake mode never uses it — it reports a name and
/// a confidence, not a transcript, and a 30 s model load for that would be absurd.
let whisper: WhisperEngine? = {
  guard let model = opt.whisperModel, opt.mode != .wake else { return nil }
  whisperQuiet()
  let prompt = opt.whisperPrompt ? whisperPrompt(opt.context) : ""
  let e = WhisperEngine(model: model, prompt: prompt, beam: opt.whisperBeam, audioCtx: opt.whisperAudioCtx, locale: opt.locale)
  e.warm()
  return e
}()

// ---------- format conversion ----------
let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
final class Converter {
  let to: AVAudioFormat
  private var from: AVAudioFormat?
  private var c: AVAudioConverter?
  /// Bug 180: the most input frames handed to AVAudioConverter in one call (nil: all of it at once).
  private let slice: Int?
  init(to: AVAudioFormat, slice: Int? = nil) { self.to = to; self.slice = slice }
  func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    // Bug 180: given more than 4096 frames in one call, AVAudioConverter can stop at 8192 frames out
    // and keep the rest of the buffer until the NEXT call (measured, 24 -> 48 kHz: 5000 in, 8192 out,
    // 38 ms kept; over 400 odd-sized buffers the backlog reached 485 ms). For speech that is the END
    // of a sentence — it sat in here while the pause (made at 48 kHz, never converted) played, then
    // came out stuck to the front of the next sentence: every sentence stopped short mid-sound.
    // Fed at most 4096 frames a call it keeps only its filter's own ~0.7 ms, whatever the sizes —
    // measured at 11.025, 16, 22.05 (Apple's voice), 24 and 44.1 kHz into 44.1 / 48 kHz, 400
    // odd-sized buffers each: worst hold 0.4-1.5 ms. The limit is on the frames IN; the slice is also
    // kept under 8192 frames OUT, so a faster-than-2x conversion stays inside what was measured.
    let slice = self.slice.map { min($0, max(256, Int(8192 * input.format.sampleRate / to.sampleRate) - 64)) }
    if let slice, input.frameLength > AVAudioFrameCount(slice), input.format.commonFormat == .pcmFormatFloat32,
       !input.format.isInterleaved, let src = input.floatChannelData {
      var parts: [AVAudioPCMBuffer] = []
      var at = 0
      let total = Int(input.frameLength)
      while at < total {
        let n = min(slice, total - at)
        guard let piece = AVAudioPCMBuffer(pcmFormat: input.format, frameCapacity: AVAudioFrameCount(n)), let dst = piece.floatChannelData else { return nil }
        piece.frameLength = AVAudioFrameCount(n)
        for ch in 0..<Int(input.format.channelCount) { dst[ch].update(from: src[ch] + at, count: n) }
        if let o = convertOnce(piece) { parts.append(o) }
        else { log("converter: slice of \(n) frames at \(at)/\(total) converted to nothing; dropped") }
        at += n
      }
      let frames = parts.reduce(0) { $0 + Int($1.frameLength) }
      guard frames > 0, let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: AVAudioFrameCount(frames)), let dst = out.floatChannelData else { return nil }
      var k = 0
      for p in parts {
        for ch in 0..<Int(to.channelCount) { (dst[ch] + k).update(from: p.floatChannelData![ch], count: Int(p.frameLength)) }
        k += Int(p.frameLength)
      }
      out.frameLength = AVAudioFrameCount(frames)
      return out
    }
    return convertOnce(input)
  }
  private func convertOnce(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    // Bug 104: with voice processing on, macOS delivers the mic as a multi-channel buffer (7 ch at
    // 44.1 kHz here) where channel 0 is the echo-cancelled voice and the rest are internal. Letting
    // AVAudioConverter downmix all of them into mono buried the voice, so recognition never heard an
    // utterance. For a mono target, take channel 0 only.
    let buf = to.channelCount == 1 ? Converter.firstChannel(of: input) : input
    if from == nil || from! != buf.format {
      from = buf.format
      c = AVAudioConverter(from: buf.format, to: to)
      log("converter \(buf.format) → \(to)")
    }
    guard let c, buf.frameLength > 0 else { return nil }
    let cap = AVAudioFrameCount(Double(buf.frameLength) * to.sampleRate / buf.format.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: cap) else { return nil }
    var fed = false
    var err: NSError?
    let status = c.convert(to: out, error: &err) { _, st in
      if fed { st.pointee = .noDataNow; return nil }
      fed = true; st.pointee = .haveData; return buf
    }
    if status == .error { log("convert failed: \(err?.localizedDescription ?? "?")"); return nil }
    return out.frameLength > 0 ? out : nil
  }

  /// Channel 0 of a deinterleaved Float32 buffer as its own mono buffer at the same sample rate.
  /// Anything that isn't multi-channel deinterleaved Float32 is returned unchanged.
  static func firstChannel(of buf: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
    let f = buf.format
    guard f.channelCount > 1, !f.isInterleaved, f.commonFormat == .pcmFormatFloat32,
          let src = buf.floatChannelData,
          let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: f.sampleRate, channels: 1, interleaved: false),
          let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buf.frameLength),
          let dst = out.floatChannelData else { return buf }
    out.frameLength = buf.frameLength
    dst[0].update(from: src[0], count: Int(buf.frameLength))
    return out
  }
}

// ---------- audio devices (bug 105) ----------
// CoreAudio device list, the choice of device per direction (with fallback to the system default
// when the chosen one is missing, and re-selection when it returns), and pointing an I/O audio unit
// at a device. The choice logic is pure so --self-test-devices can check it without hardware.
struct AudioDev { let id: AudioDeviceID; let uid: String; let name: String; let input: Bool; let output: Bool; let transport: String }
enum DevKind: String { case input, output }

func caAddr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func caU32(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32? {
  var addr = caAddr(sel)
  var v: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &v) == noErr ? v : nil
}
func caString(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
  var addr = caAddr(sel)
  var cf: Unmanaged<CFString>? = nil
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  let st = withUnsafeMutablePointer(to: &cf) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
  guard st == noErr, let s = cf?.takeRetainedValue() else { return nil }
  return s as String
}
func streamCount(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int {
  var addr = caAddr(kAudioDevicePropertyStreams, scope)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr else { return 0 }
  return Int(size) / MemoryLayout<AudioStreamID>.size
}
func fourCC(_ s: String) -> UInt32 { s.utf8.reduce(0) { ($0 << 8) | UInt32($1) } }
func transportName(_ t: UInt32) -> String {
  switch t {
  case kAudioDeviceTransportTypeBuiltIn: return "built-in"
  case kAudioDeviceTransportTypeUSB: return "usb"
  case kAudioDeviceTransportTypeBluetooth: return "bluetooth"
  case kAudioDeviceTransportTypeBluetoothLE: return "bluetooth-le"
  case kAudioDeviceTransportTypeHDMI: return "hdmi"
  case kAudioDeviceTransportTypeDisplayPort: return "displayport"
  case kAudioDeviceTransportTypeAirPlay: return "airplay"
  case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt"
  case kAudioDeviceTransportTypePCI: return "pci"
  case kAudioDeviceTransportTypeFireWire: return "firewire"
  case kAudioDeviceTransportTypeVirtual: return "virtual"
  case kAudioDeviceTransportTypeAggregate, kAudioDeviceTransportTypeAutoAggregate: return "aggregate"
  case fourCC("ccwd"), fourCC("ccwl"): return "continuity"
  default: return "unknown"
  }
}
/// Voice processing builds private aggregates of the devices it uses; they are not user choices.
/// Bug 219 (review round 1): how long past a line's scheduled end its played-back report may take before the line is
/// ended anyway — the output route's own latency (CoreAudio's device latency + safety offset + buffer), and 400 ms
/// more on Bluetooth, whose headset reports only after its radio has played the audio.
func overrunMargin(latencyMs: Double, transport: String) -> Double {
  250 + max(0, latencyMs) + (transport.hasPrefix("bluetooth") ? 400 : 0)
}
/// The output device's latency in ms (device latency + safety offset + I/O buffer, output scope).
func outputLatencyMs(_ id: AudioDeviceID) -> Double {
  func u32(_ sel: AudioObjectPropertySelector) -> Double {
    var a = caAddr(sel, kAudioObjectPropertyScopeOutput)
    var v: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &a, 0, nil, &size, &v) == noErr ? Double(v) : 0
  }
  var rate: Float64 = 0
  var a = caAddr(kAudioDevicePropertyNominalSampleRate)
  var size = UInt32(MemoryLayout<Float64>.size)
  guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &rate) == noErr, rate > 0 else { return 0 }
  return (u32(kAudioDevicePropertyLatency) + u32(kAudioDevicePropertySafetyOffset) + u32(kAudioDevicePropertyBufferFrameSize)) / rate * 1000
}
func isPrivateAggregate(uid: String) -> Bool { uid.hasPrefix("VPAUAggregateAudioDevice") || uid.hasPrefix("CADefaultDeviceAggregate") }

func listDevices() -> [AudioDev] {
  var addr = caAddr(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  let sys = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids.compactMap { id in
    guard let uid = caString(id, kAudioDevicePropertyDeviceUID), !isPrivateAggregate(uid: uid) else { return nil }
    let input = streamCount(id, kAudioObjectPropertyScopeInput) > 0
    let output = streamCount(id, kAudioObjectPropertyScopeOutput) > 0
    guard input || output else { return nil }
    let name = caString(id, kAudioObjectPropertyName) ?? uid
    return AudioDev(id: id, uid: uid, name: name, input: input, output: output, transport: transportName(caU32(id, kAudioDevicePropertyTransportType) ?? 0))
  }
}
func defaultDeviceID(_ kind: DevKind) -> AudioDeviceID? {
  let v = caU32(AudioObjectID(kAudioObjectSystemObject), kind == .input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice)
  return v.flatMap { $0 == kAudioObjectUnknown ? nil : $0 }
}
func defaultDevice(_ kind: DevKind, _ devs: [AudioDev]) -> AudioDev? { defaultDeviceID(kind).flatMap { id in devs.first { $0.id == id } } }
func deviceJSON(_ d: AudioDev, defIn: AudioDeviceID?, defOut: AudioDeviceID?) -> [String: Any] {
  ["uid": d.uid, "name": d.name, "input": d.input, "output": d.output, "transport": d.transport, "defaultInput": d.input && d.id == defIn, "defaultOutput": d.output && d.id == defOut]
}
func deviceRef(_ d: AudioDev?) -> Any { d.map { ["uid": $0.uid, "name": $0.name] as [String: Any] } ?? NSNull() }

/// The user's choice for one direction. `active` is the device to pin (nil = follow the system
/// default). A chosen device that is missing falls back to the default and says so once; when it
/// comes back it is selected again.
final class DeviceChoice {
  let kind: DevKind
  let preferred: String?
  private(set) var active: AudioDev?
  private(set) var fellBack = false
  private var first = true
  init(kind: DevKind, preferred: String?) { self.kind = kind; self.preferred = preferred }

  /// Re-evaluates against the current devices: the event to emit, and whether a running audio path must be rebuilt.
  func update(_ devices: [AudioDev], defaultName: String) -> (event: [String: Any]?, rebuild: Bool) {
    let initial = first
    first = false
    guard let uid = preferred else { return (nil, false) }
    if let d = devices.first(where: { $0.uid == uid && (kind == .input ? $0.input : $0.output) }) {
      let changed = active?.id != d.id
      let wasFallback = fellBack
      active = d
      fellBack = false
      if wasFallback { return (["type": "device-restored", "kind": kind.rawValue, "uid": uid, "name": d.name], !initial) }
      return (nil, changed && !initial)
    }
    if fellBack { return (nil, false) }
    let lastName = active?.name ?? ""
    active = nil
    fellBack = true
    return (["type": "device-fallback", "kind": kind.rawValue, "uid": uid, "name": lastName, "fallback": defaultName], !initial)
  }
}

/// Points an I/O unit at a device. Returns nil on success, or why not (including a unit that
/// accepts the property but keeps its old device, which voice processing can do).
func setCurrentDevice(_ unit: AudioUnit?, _ id: AudioDeviceID, element: AudioUnitElement) -> String? {
  guard let unit else { return "no audio unit" }
  var dev = id
  let st = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, element, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
  if st != noErr { return "setting device \(id) failed (\(st))" }
  var back = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  if AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, element, &back, &size) == noErr, back != id {
    return "device \(id) not taken (the unit reports \(back))"
  }
  return nil
}

/// Resolves one direction for a one-shot mode (meter, speaker test), reporting a fallback.
func resolveOnce(_ kind: DevKind, _ uid: String?) -> (choice: DeviceChoice, device: AudioDev?) {
  let devs = listDevices()
  let c = DeviceChoice(kind: kind, preferred: uid)
  if let e = c.update(devs, defaultName: defaultDevice(kind, devs)?.name ?? "").event { log("device: \(e)"); emit(e) }
  return (c, c.active ?? defaultDevice(kind, devs))
}

func runListDevices() -> Never {
  let devs = listDevices()
  let di = defaultDeviceID(.input), dout = defaultDeviceID(.output)
  log("list-devices: \(devs.count) devices")
  emit(["type": "devices", "devices": devs.map { deviceJSON($0, defIn: di, defOut: dout) }])
  leave(0)
}

/// Settings → Voice: the chosen microphone's level, ~10 times a second, until stdin closes.
func runMeter() -> Never {
  let (choice, dev) = resolveOnce(.input, opt.inputDevice)
  emit(["type": "devices", "input": deviceRef(dev), "output": NSNull(), "echoCancellation": false])
  if opt.dryRun { emit(["type": "end"]); leave(0) }
  requireMicPermission()
  let engine = AVAudioEngine()
  if let d = choice.active, let why = setCurrentDevice(engine.inputNode.audioUnit, d.id, element: 0) {
    fail("no-audio", "\(d.name) couldn't be selected: \(why)", 1)
  }
  // Bug 196: the tap format is planned against the hardware (a stale rate is an uncatchable abort).
  let hwFmt = engine.inputNode.inputFormat(forBus: 0), nodeFmt = engine.inputNode.outputFormat(forBus: 0)
  let fmt: AVAudioFormat
  switch planTap(hardware: TapFormatInfo(hwFmt), node: TapFormatInfo(nodeFmt), strictRate: true) {
  case .retry: fail("no-audio", SourceError.noInputDevice.errorDescription ?? "No microphone input", 1)
  case .node: fmt = nodeFmt
  case .hardware: fmt = hwFmt
  }
  let lastAt = UnsafeMutablePointer<Double>.allocate(capacity: 1)
  lastAt.pointee = 0
  installTapSafely(engine.inputNode, format: fmt, bufferSize: 2048) { buf, _ in
    guard let ch = buf.floatChannelData, buf.frameLength > 0 else { return }
    let n = Int(buf.frameLength)
    var sum: Float = 0
    for i in 0..<n { sum += ch[0][i] * ch[0][i] }
    let db = max(-100, 20 * log10(Double(sqrt(sum / Float(n))) + 1e-10))
    let now = nowMs()
    if now - lastAt.pointee >= 100 { lastAt.pointee = now; emit(["type": "level", "db": (db * 10).rounded() / 10]) }
  }
  do { engine.prepare(); try engine.start() } catch { fail("no-audio", "The microphone couldn't start: \(error.localizedDescription)", 1) }
  emit(["type": "ready", "source": "meter"])
  let finish = { engine.stop(); emit(["type": "end"]); leave(0) }
  Thread {
    while let l = readLine() { if l.trimmingCharacters(in: .whitespaces) == "stop" { break } }
    finish()
  }.start()
  DispatchQueue.main.asyncAfter(deadline: .now() + 120) { finish() }
  RunLoop.main.run()
  leave(0)
}

/// Settings → Voice "Test speaker": one short phrase through the chosen output, then exit.
func runSpeakerTest() -> Never {
  let (choice, dev) = resolveOnce(.output, opt.outputDevice)
  emit(["type": "devices", "input": NSNull(), "output": deviceRef(dev), "echoCancellation": false])
  // Bug 106: Settings → Voice "Preview" — which voice this is (the requested one, else the best installed).
  if let v = Speaker.pickVoice(name: nil, lang: nil).info { emit(["type": "voice"].merging(v.json) { a, _ in a }) }
  if opt.dryRun { emit(["type": "end"]); leave(0) }
  let engine = AVAudioEngine()
  let player = AVAudioPlayerNode()
  let fmt = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
  engine.attach(player)
  engine.connect(player, to: engine.mainMixerNode, format: fmt)
  if let d = choice.active, let why = setCurrentDevice(engine.outputNode.audioUnit, d.id, element: 0) {
    fail("no-audio", "\(d.name) couldn't be selected: \(why)", 1)
  }
  do { engine.prepare(); try engine.start() } catch { fail("no-audio", "The speaker couldn't start: \(error.localizedDescription)", 1) }
  player.play()
  let speaker = Speaker(player: player, format: fmt, engineRunning: { engine.isRunning })
  speaker.onEnd = { _ in q.asyncAfter(deadline: .now() + .milliseconds(250)) { engine.stop(); emit(["type": "end"]); leave(0) } }
  let phrase = opt.phrase ?? "Hi! This is how I'll sound when we talk."
  if opt.pcmStdin {
    // Bug 107: Preview of a natural (Kokoro) voice — the app feeds its PCM; Apple's voice is the fallback.
    q.async { speaker.speak(id: "test", text: phrase, voice: nil, rate: nil, lang: nil, engine: "pcm") }
    Thread {
      while let line = readLine() { let l = line.trimmingCharacters(in: .whitespaces); q.async { _ = pcmCommand(l, speaker) } }
      q.async { speaker.pcmFail(id: "test", why: "stdin closed") }
    }.start()
  } else {
    q.async { speaker.speak(id: "test", text: phrase, voice: nil, rate: nil, lang: nil) }
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + opt.maxSeconds) { fail("no-audio", "The test sound didn't finish playing.", 1) }
  RunLoop.main.run()
  leave(0)
}

/// --self-test-playback (bug 141): the Speaker on an OFFLINE engine (manual rendering: no device, no
/// permission), restarted the way a configuration change restarts the call's engine. Measures the
/// frames that actually render, so "logged as spoken but never heard" fails here.
func runPlaybackSelfTest() -> Never {
  var cases = 0
  var failures: [String] = []
  func check(_ name: String, _ ok: Bool) { cases += 1; if !ok { failures.append(name); log("FAIL \(name)") } }
  let fmt = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
  func makeEngine() -> (AVAudioEngine, AVAudioPlayerNode)? {
    let e = AVAudioEngine()
    let p = AVAudioPlayerNode()
    e.attach(p)
    e.connect(p, to: e.mainMixerNode, format: fmt)
    do { try e.enableManualRenderingMode(.offline, format: fmt, maximumFrameCount: 4800); try e.start() } catch { log("offline engine: \(error)"); return nil }
    p.play()
    return (e, p)
  }
  /// Renders `seconds` and returns how many frames carried sound.
  func render(_ e: AVAudioEngine, seconds: Double) -> Int {
    guard let buf = AVAudioPCMBuffer(pcmFormat: e.manualRenderingFormat, frameCapacity: 4800) else { return 0 }
    var loud = 0
    var left = Int(seconds * 48000)
    while left > 0 {
      let n = min(4800, left)
      guard (try? e.renderOffline(AVAudioFrameCount(n), to: buf)) == .success else { break }
      if let f = buf.floatChannelData { for i in 0..<Int(buf.frameLength) where abs(f[0][i]) > 0.001 { loud += 1 } }
      left -= n
    }
    Thread.sleep(forTimeInterval: 0.05)
    q.sync {}
    return loud
  }
  // A 1.0 s greeting of Kokoro PCM (24 kHz), sent in 0.5 s chunks as the app sends a cached line.
  let tone = (0..<24000).map { Float(0.3 * sin(Double($0) * 2 * Double.pi * 220 / 24000)) }
  let chunks = stride(from: 0, to: tone.count, by: 12000).map { i in Array(tone[i..<min(i + 12000, tone.count)]).withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString() }
  let full = 48000
  func queueGreeting(_ sp: Speaker, _ id: String) {
    q.sync {
      sp.speak(id: id, text: "Hey, what's up?", voice: nil, rate: nil, lang: nil, engine: "pcm")
      for c in chunks { _ = pcmCommand("pcm {\"id\":\"\(id)\",\"data\":\"\(c)\"}", sp) }
      _ = pcmCommand("pcm-end {\"id\":\"\(id)\"}", sp)
    }
  }
  /// What MicSource.restart() does to the engine, with the speaker told on both sides.
  func restart(_ e: AVAudioEngine, _ p: AVAudioPlayerNode, _ sp: Speaker, settleMs: Double) {
    q.sync { sp.pathStopping() }
    e.stop()
    try? e.start()
    p.play()
    q.sync { sp.pathStarted(settleMs: settleMs) }
  }

  // 1. The field log (calls 444eb49f / 015c5b35): the greeting is queued, then a configuration change
  //    restarts the engine ~0.1 s later. All of it must still play, and it ends once.
  if let (e, p) = makeEngine() {
    let sp = Speaker(player: p, format: fmt, engineRunning: { e.isRunning }, playedBack: .dataRendered)
    var ended: [String] = []
    sp.onEnd = { ended.append($0) }
    queueGreeting(sp, "g1")
    var heard = render(e, seconds: 0.1)
    restart(e, p, sp, settleMs: 0)
    heard += render(e, seconds: 2)
    check("config change right after the greeting is queued: all of it plays (\(heard)/\(full))", heard >= full * 95 / 100)
    check("…and at most one 0.5 s chunk is heard twice (\(heard)/\(full))", heard <= full + 24000 + 4800)
    q.sync { sp.checkDeadline(nowMs() + 10_000) }
    check("…and it ends once (\(ended))", ended == ["g1"])
  } else { check("offline engine starts", false) }

  // 2. A line queued before the audio path has settled waits for it, then plays in full.
  if let (e, p) = makeEngine() {
    let sp = Speaker(player: p, format: fmt, engineRunning: { e.isRunning }, holdUntilStarted: true, playedBack: .dataRendered)
    queueGreeting(sp, "g2")
    let early = render(e, seconds: 0.3)
    check("nothing plays before the audio path has settled (\(early))", early == 0)
    q.sync { sp.pathStarted(settleMs: 0) }
    let heard = render(e, seconds: 2)
    check("then all of it plays (\(heard)/\(full))", heard >= full * 95 / 100 && heard <= full + 4800)
  } else { check("offline engine starts", false) }

  // 3. A configuration change inside the settle window holds the line through the second restart.
  if let (e, p) = makeEngine() {
    let sp = Speaker(player: p, format: fmt, engineRunning: { e.isRunning }, holdUntilStarted: true, playedBack: .dataRendered)
    queueGreeting(sp, "g3")
    q.sync { sp.pathStarted(settleMs: 150) }
    q.sync { sp.pathStopping() }
    Thread.sleep(forTimeInterval: 0.3)
    let during = render(e, seconds: 0.2)
    check("a change inside the settle window keeps holding (\(during))", during == 0)
    restart(e, p, sp, settleMs: 100)
    Thread.sleep(forTimeInterval: 0.25)
    let heard = render(e, seconds: 2)
    check("…and the line plays once the path is quiet (\(heard)/\(full))", heard >= full * 95 / 100 && heard <= full + 4800)
  } else { check("offline engine starts", false) }

  // 4. Mid-reply: a restart while the second sentence plays keeps the rest of the reply.
  if let (e, p) = makeEngine() {
    let sp = Speaker(player: p, format: fmt, engineRunning: { e.isRunning }, playedBack: .dataRendered)
    queueGreeting(sp, "s1")
    q.sync {
      sp.speak(id: "s2", text: "more", voice: nil, rate: nil, lang: nil, queue: true, engine: "pcm")
      for c in chunks { _ = pcmCommand("pcm {\"id\":\"s2\",\"data\":\"\(c)\"}", sp) }
      _ = pcmCommand("pcm-end {\"id\":\"s2\"}", sp)
    }
    var heard = render(e, seconds: 1.2)
    restart(e, p, sp, settleMs: 0)
    heard += render(e, seconds: 2)
    check("a restart mid-reply loses nothing (\(heard)/\(2 * full))", heard >= 2 * full * 95 / 100 && heard <= 2 * full + 24000 + 4800)
  } else { check("offline engine starts", false) }

  // 5. Bug 180: a sentence's last milliseconds play BEFORE its pause, not after it. The converter
  //    keeps some of every line inside it (measured: up to 38 ms after a 5000-sample chunk, the size
  //    a Kokoro segment ends on) until the next input arrives. The pause used to bypass it, so that
  //    held end came out after the pause, glued to the front of the next sentence: every sentence
  //    stopped short, mid-sound, and finished a fifth of a second later.
  //    Run at Kokoro's 24 kHz and at 22.05 kHz, the rate Apple's fallback voice arrives in (a
  //    conversion faster than 2x, so a 4096-frame slice alone would come out over 8192 frames).
  for rate in [24000.0, 22050.0] {
  if let (e, p) = makeEngine() {
    let sp = Speaker(player: p, format: fmt, engineRunning: { e.isRunning }, playedBack: .dataRendered)
    let tag = "\(Int(rate)) Hz"
    let inFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
    let n1 = Int(rate * 0.4) // 400 ms, loud right up to a 5 ms fade
    let nf = Int(rate * 0.005)
    let s1 = (0..<n1).map { i -> Float in
      let fade = i >= n1 - nf ? Float(0.5 - 0.5 * cos(Double.pi * Double(n1 - 1 - i) / Double(nf))) : 1
      return Float(0.3 * sin(Double(i) * 2 * Double.pi * 220 / rate)) * fade
    }
    let s2 = [Float](repeating: 0, count: Int(rate * 0.1)) + (0..<Int(rate * 0.2)).map { Float(0.3 * sin(Double($0) * 2 * Double.pi * 330 / rate)) }
    func buf(_ x: ArraySlice<Float>) -> AVAudioPCMBuffer {
      let b = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: AVAudioFrameCount(x.count))!
      b.frameLength = AVAudioFrameCount(x.count)
      for (k, v) in x.enumerated() { b.floatChannelData![0][k] = v }
      return b
    }
    let cut = Int(rate * 5000 / 24000) // the size a Kokoro segment ends on, at this rate
    q.sync {
      sp.speak(id: "t1", text: "One.", voice: nil, rate: nil, lang: nil, engine: "pcm", pauseMs: 200)
      sp.pcm(id: "t1", buffer: buf(s1[0..<cut]))
      sp.pcm(id: "t1", buffer: buf(s1[cut...]))
      _ = pcmCommand("pcm-end {\"id\":\"t1\"}", sp)
      sp.speak(id: "t2", text: "Two.", voice: nil, rate: nil, lang: nil, queue: true, engine: "pcm")
      sp.pcm(id: "t2", buffer: buf(s2[...]))
      _ = pcmCommand("pcm-end {\"id\":\"t2\"}", sp)
    }
    // Render the reply into one array.
    var out = [Float]()
    if let rb = AVAudioPCMBuffer(pcmFormat: e.manualRenderingFormat, frameCapacity: 4800) {
      for _ in 0..<20 {
        guard (try? e.renderOffline(4800, to: rb)) == .success, let f = rb.floatChannelData else { break }
        out.append(contentsOf: UnsafeBufferPointer(start: f[0], count: Int(rb.frameLength)))
      }
    }
    Thread.sleep(forTimeInterval: 0.05)
    q.sync {}
    let n1out = 19200 // 400 ms at 48 kHz
    let start = out.firstIndex { abs($0) > 0.001 } ?? 0
    // The pause: the first run of 150 ms or more under -80 dBFS after the first sentence starts.
    var pauseAt = -1, run = 0
    for i in start..<out.count { if abs(out[i]) < 1e-4 { run += 1; if run >= 7200 { pauseAt = i - run + 1; break } } else { run = 0 } }
    let before = pauseAt > start ? out[start..<pauseAt].filter { abs($0) > 0.001 }.count : 0
    check("\(tag): a sentence plays all of itself before its pause (\(before) of ~\(n1out) samples)", pauseAt > 0 && before >= n1out - 480)
    // …and what follows the pause is the next sentence, not the end of this one: sentence 2 opens on
    // 100 ms of silence, so nothing may sound in the first 80 ms after the pause's 200 ms.
    let pauseEnd = pauseAt + 9600
    let early = pauseEnd + 3840 <= out.count ? out[pauseEnd..<(pauseEnd + 3840)].map { abs($0) }.max() ?? 1 : 1
    check("\(tag): nothing of it is left to play after the pause (\(early))", pauseAt > 0 && early < 0.001)
    // …and nothing is left BEHIND in the converter either: the next sentence starts exactly where its
    // own timeline says (400 ms of speech, 200 ms of pause, 100 ms of its lead-in), not late by
    // whatever the converter was sitting on. Unsliced, that backlog grew to 485 ms over 400 odd-sized
    // chunks (measured): a lag on every line after it, and on barge-in.
    let onset2 = out[(start + 1)...].indices.first { i in abs(out[i]) > 0.001 && i > pauseAt + 9600 } ?? 0
    check("\(tag): the next sentence starts on time (\(onset2 - start) of \(n1out + 9600 + 4800) samples)", abs(onset2 - start - (n1out + 9600 + 4800)) <= 96)
    // …and the reply's LAST line, with no pause after it to push it through, plays to its end
    // rather than leaving its final syllable in the converter until the next reply.
    let heard2 = onset2 > 0 ? out[onset2...].filter { abs($0) > 0.001 }.count : 0
    check("\(tag): the last line plays all of itself (\(heard2) of ~9600 samples)", heard2 >= 9600 - 480)
  } else { check("offline engine starts", false) }
  }

  // 6. Bug 188: a barge-in FADES the Bot out (~80 ms) instead of stopping it dead mid-waveform — a dead stop
  //    left a step at the cut on 173 of 175 cut points of a real reply (test-reports/voice-call-feel). The
  //    fade runs on the wall clock, so the offline engine is rendered in 5 ms slices at about real time.
  if let (e, p) = makeEngine() {
    let sp = Speaker(player: p, format: fmt, engineRunning: { e.isRunning }, playedBack: .dataRendered)
    var ended: [String] = []
    sp.onEnd = { ended.append($0) }
    queueGreeting(sp, "b1")
    guard let rb = AVAudioPCMBuffer(pcmFormat: e.manualRenderingFormat, frameCapacity: 240) else { exit(1) }
    func slice() -> Float {
      guard (try? e.renderOffline(240, to: rb)) == .success, let f = rb.floatChannelData else { return 0 }
      return (0..<Int(rb.frameLength)).map { abs(f[0][$0]) }.max() ?? 0
    }
    var before: Float = 0
    for _ in 0..<40 { before = max(before, slice()); Thread.sleep(forTimeInterval: 0.005) } // 200 ms in
    q.sync { sp.stop(interrupted: true) }
    check("…the barge-in still ends the line at once (\(ended))", ended == ["b1"])
    var peaks: [Float] = []
    for _ in 0..<60 { peaks.append(slice()); Thread.sleep(forTimeInterval: 0.005) }
    let lastLoud = peaks.lastIndex { $0 > 0.001 } ?? -1
    check("barge-in: the voice fades rather than stops dead (sounds for \((lastLoud + 1) * 5) ms after the stop)", lastLoud >= 5)
    check("barge-in: …and is gone within ~150 ms (\((lastLoud + 1) * 5) ms)", lastLoud < 30)
    check("barge-in: …getting quieter as it goes (first \(peaks.first ?? 0), last \(lastLoud >= 0 ? peaks[lastLoud] : 0) of \(before))", lastLoud >= 1 && peaks[lastLoud] < before * 0.5)
    // A new line straight after (the next reply, "sorry, go ahead") is never faded or cut by the old fade.
    q.sync { sp.stop(interrupted: true) }
    queueGreeting(sp, "b2")
    var heard = 0
    for _ in 0..<60 { if slice() > 0.2 { heard += 1 }; Thread.sleep(forTimeInterval: 0.005) }
    check("barge-in: a line queued after it plays at full level (\(heard) loud slices of 60)", heard >= 50)
  } else { check("offline engine starts", false) }

  // 7. Bug 219: "speech playback overran" ended a line that was still PLAYING. Its deadline ran from when the line
  //    was synthesized, so a line queued behind 3 s+ of audio was declared done mid-sentence (the user's calls: 110
  //    of 137 overruns, p50 1.7 s early) — and with no line left, the helper stopped counting itself as speaking:
  //    barge-in went off, and the user could not stop the rest of it. The deadline now runs from where the line's
  //    last audio sits on the playback timeline; a lost end still ends the line, just after its audio.
  func queueLine(_ sp: Speaker, _ id: String, seconds: Double) {
    let n = Int(seconds * 24000)
    let pcm = (0..<n).map { Float(0.3 * sin(Double($0) * 2 * Double.pi * 220 / 24000)) }
    q.sync {
      sp.speak(id: id, text: "line", voice: nil, rate: nil, lang: nil, queue: true, engine: "pcm")
      for i in stride(from: 0, to: n, by: 12000) {
        let c = Array(pcm[i..<min(i + 12000, n)]).withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
        _ = pcmCommand("pcm {\"id\":\"\(id)\",\"data\":\"\(c)\"}", sp)
      }
      _ = pcmCommand("pcm-end {\"id\":\"\(id)\"}", sp)
    }
  }
  if let (e, p) = makeEngine() {
    let sp = Speaker(player: p, format: fmt, engineRunning: { e.isRunning }, playedBack: .dataRendered)
    var ended: [String] = []
    sp.onEnd = { ended.append($0) }
    let t0 = nowMs()
    queueLine(sp, "o1", seconds: 2); queueLine(sp, "o2", seconds: 2); queueLine(sp, "o3", seconds: 1)
    _ = render(e, seconds: 4.2) // o1 and o2 have played; o3 is 0.2 s in
    // 4.5 s after o3 was synthesized — past the old deadline (its 1 s + 3 s) — while o3 is still playing.
    q.sync { sp.checkDeadline(t0 + 4_500) }
    check("overrun: a line queued behind 4 s of audio is not ended while it plays (\(ended))", ended == ["o1", "o2"])
    check("overrun: …so the helper still counts itself as speaking (barge-in stays on)", q.sync { sp.isSpeaking })
    _ = render(e, seconds: 1.2)
    check("overrun: …and it ends once its audio has played, once (\(ended))", ended == ["o1", "o2", "o3"])
  } else { check("offline engine starts", false) }
  // Review round 1: the margin follows the output route — the device's own latency, and 400 ms more on Bluetooth
  // (a headset reports "played back" only after its radio has played it).
  check("overrun margin: wired, no reported latency → 250 ms", overrunMargin(latencyMs: 0, transport: "built-in") == 250)
  check("overrun margin: a Bluetooth headset reporting 150 ms → 250 + 150 + 400", overrunMargin(latencyMs: 150, transport: "bluetooth") == 800)
  check("overrun margin: Bluetooth LE too", overrunMargin(latencyMs: 0, transport: "bluetooth-le") == 650)
  if let (e, p) = makeEngine() {
    // .dataPlayedBack on a Bluetooth route (the device's report is late): the audio has rendered, the report hasn't
    // come — the line must not be ended inside the route's margin, and is ended once past it.
    let sp = Speaker(player: p, format: fmt, engineRunning: { e.isRunning }, playedBack: .dataPlayedBack)
    q.sync { sp.setOutputLatency(150, transport: "bluetooth") }
    var ended: [String] = []
    sp.onEnd = { ended.append($0) }
    let t0 = nowMs()
    queueLine(sp, "bt1", seconds: 1)
    // The offline engine's clock only moves when it renders, so the wall time checked is the time rendered.
    _ = render(e, seconds: 1.7)
    q.sync { sp.checkDeadline(t0 + 1_700) }
    check("overrun (Bluetooth, played-back late): not ended inside its 800 ms margin (\(ended))", ended.isEmpty)
    _ = render(e, seconds: 0.2)
    q.sync { sp.checkDeadline(t0 + 1_900) }
    check("overrun (Bluetooth): …ended once past it (\(ended))", ended == ["bt1"])
  } else { check("offline engine starts", false) }
  if let (e, p) = makeEngine() {
    // A render stall mid-line (the engine stopped pulling audio): the line's end moves with it — never ended early.
    let sp = Speaker(player: p, format: fmt, engineRunning: { e.isRunning }, playedBack: .dataRendered)
    var ended: [String] = []
    sp.onEnd = { ended.append($0) }
    let t0 = nowMs()
    queueLine(sp, "st1", seconds: 1)
    _ = render(e, seconds: 0.3)
    q.sync { sp.checkDeadline(t0 + 3_000) } // 2 s past its timeline end, but only 0.3 s of it has rendered
    check("overrun (render stall): a line only 0.3 s into its audio is not ended (\(ended))", ended.isEmpty)
    _ = render(e, seconds: 1)
    check("overrun (render stall): …and it ends when the rest has played, once (\(ended))", ended == ["st1"])
  } else { check("offline engine starts", false) }

  emit(["type": "self-test", "ok": failures.isEmpty, "cases": cases, "failures": failures])
  exit(failures.isEmpty ? 0 : 1)
}

/// --self-test-spatial (bug 213): the call's real speech graph on an OFFLINE engine (no device, no
/// microphone, nothing played out loud): the direct player and the six HRTF seat players, wired exactly
/// as a call wires them (SeatBank.wire), driven through the Speaker as a call drives it (PCM chunks
/// through the converter, pauses, queueing, barge-in). Measures what comes out: per-seat level and time
/// differences between the ears, loudness against today's centred voice, peaks, the gap between two
/// Bots, the fade, first-audio latency and CPU. `--speech a,b,c` uses those recordings (one per Bot);
/// without it, speech-shaped noise. `--out DIR` also writes the WAVs and report.json there.
func runSpatialSelfTest() -> Never {
  var cases = 0
  var failures: [String] = []
  func check(_ name: String, _ ok: Bool) { cases += 1; if !ok { failures.append(name); log("FAIL \(name)") } else { log("ok \(name)") } }
  var report: [String: Any] = [:]
  let rate = 48000.0
  let stereo = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2)!
  let mono48 = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!

  // ---- 1. the route rules ----
  func rt(_ t: String, _ ch: Int, _ ds: String? = nil, _ name: String = "Output", input: Bool = false) -> OutputRoute {
    OutputRoute(transport: t, channels: ch, dataSource: ds.map(fourCC), name: name, hasInput: input)
  }
  check("route: the Mac's speakers → speakers", routeMode(rt("built-in", 2, "ispk", "MacBook Pro Speakers")) == .speakers)
  check("route: headphones on the jack → headphones", routeMode(rt("built-in", 2, "hdpn", "Headphones")) == .headphones)
  check("route: the jack as its own device (\"External Headphones\") → headphones", routeMode(rt("built-in", 2, nil, "External Headphones")) == .headphones)
  check("route: AirPods (stereo) → headphones", routeMode(rt("bluetooth", 2, nil, "Alex's AirPods Pro", input: true)) == .headphones)
  check("route: a Bluetooth headset on hands-free (mono) → centred", routeMode(rt("bluetooth", 1, nil, "Alex's AirPods Pro", input: true)) == .centre)
  check("route: a Bluetooth speaker → speakers", routeMode(rt("bluetooth", 2, nil, "JBL Flip 6")) == .speakers)
  check("route: a USB headset → headphones", routeMode(rt("usb", 2, nil, "Jabra Evolve2 65", input: true)) == .headphones)
  check("route: an unnamed USB device with a mic → headphones (a headset)", routeMode(rt("usb", 2, nil, "USB Audio Device", input: true)) == .headphones)
  check("route: a USB audio interface → speakers", routeMode(rt("usb", 2, nil, "Scarlett 2i2 USB", input: true)) == .speakers)
  check("route: a USB output with no mic → speakers", routeMode(rt("usb", 2, nil, "USB Audio DAC")) == .speakers)
  check("route: a Studio Display → speakers", routeMode(rt("usb", 2, nil, "Studio Display Speakers", input: true)) == .speakers)
  check("route: HDMI → speakers", routeMode(rt("hdmi", 2, nil, "LG UltraFine")) == .speakers)
  check("route: virtual / unknown → centred", routeMode(rt("virtual", 2, nil, "BlackHole 2ch")) == .centre && routeMode(nil) == .centre)
  check("route: overrides (and a mono output stays centred whatever)", routeMode(rt("built-in", 2, "ispk"), override: "headphones") == .headphones
        && routeMode(rt("bluetooth", 2), override: "speakers") == .speakers && routeMode(rt("bluetooth", 2), override: "off") == .centre
        && routeMode(rt("bluetooth", 1), override: "headphones") == .centre)

  // ---- 2. the microphone that keeps a Bluetooth headset in stereo ----
  let airpods = AudioDev(id: 40, uid: "AP", name: "AirPods Pro", input: true, output: true, transport: "bluetooth")
  let macMic = AudioDev(id: 1, uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", input: true, output: false, transport: "built-in")
  let macSpk = AudioDev(id: 2, uid: "BuiltInSpeakerDevice", name: "MacBook Pro Speakers", input: false, output: true, transport: "built-in")
  let usbHeadset = AudioDev(id: 50, uid: "JABRA", name: "Jabra Evolve2 65", input: true, output: true, transport: "usb")
  let leBuds = AudioDev(id: 60, uid: "LE", name: "LE Buds", input: true, output: true, transport: "bluetooth-le")
  let usbMic = AudioDev(id: 70, uid: "YETI", name: "Yeti", input: true, output: false, transport: "usb")
  // The headphone jack's own input, listed first on some Macs even with nothing plugged in.
  let jackMic = AudioDev(id: 3, uid: "BuiltInHeadphoneInputDevice", name: "External Microphone", input: true, output: false, transport: "built-in")
  let all = [jackMic, macMic, macSpk, airpods, usbHeadset, leBuds, usbMic]
  // How this macOS lists a Bluetooth headset: an input and an output device, same name, different ids.
  let a40in = AudioDev(id: 80, uid: "84-9D:input", name: "Soundcore Space A40", input: true, output: false, transport: "bluetooth")
  let a40out = AudioDev(id: 81, uid: "84-9D:output", name: "Soundcore Space A40", input: false, output: true, transport: "bluetooth")
  check("mic: a headset listed as two devices (input / output) → the Mac's mic, not the jack's", micKeepingStereo(input: a40in, output: a40out, outputChannels: 1, devices: all + [a40in, a40out])?.id == macMic.id)
  check("mic: only the jack's input besides the headset → the headset's own", micKeepingStereo(input: a40in, output: a40out, outputChannels: 2, devices: [jackMic, a40in, a40out]) == nil)
  check("mic: AirPods as mic and output → the Mac's mic (stereo kept)", micKeepingStereo(input: airpods, output: airpods, outputChannels: 2, devices: all)?.id == macMic.id)
  check("mic: …also when the AirPods are already on hands-free", micKeepingStereo(input: airpods, output: airpods, outputChannels: 1, devices: all)?.id == macMic.id)
  check("mic: a USB headset keeps its own mic (it stays stereo)", micKeepingStereo(input: usbHeadset, output: usbHeadset, outputChannels: 2, devices: all) == nil)
  check("mic: a Bluetooth LE headset keeps its mic while it stays stereo", micKeepingStereo(input: leBuds, output: leBuds, outputChannels: 2, devices: all) == nil)
  check("mic: …and not once it drops to mono", micKeepingStereo(input: leBuds, output: leBuds, outputChannels: 1, devices: all)?.id == macMic.id)
  check("mic: no built-in mic (a Mac mini) → the headset's own", micKeepingStereo(input: airpods, output: airpods, outputChannels: 2, devices: [airpods, macSpk]) == nil)
  check("mic: the AirPods mic with the Mac's speakers → left alone", micKeepingStereo(input: airpods, output: macSpk, outputChannels: 2, devices: all) == nil)
  check("mic: a chosen USB mic with AirPods playing → left alone", micKeepingStereo(input: usbMic, output: airpods, outputChannels: 2, devices: all) == nil)

  // Review round 1: the user's own choice is kept, and never the Mac's mic with the lid closed.
  check("mic: a microphone the user chose is never swapped", micKeepingStereo(input: airpods, output: airpods, outputChannels: 1, devices: all, userChose: true) == nil)
  check("mic: never the Mac's mic with the lid closed (clamshell)", micKeepingStereo(input: airpods, output: airpods, outputChannels: 1, devices: all, lidClosed: true) == nil)
  check("mic: the lid state reads without error on this Mac (\(lidClosed() ? "closed" : "open"))", true)
  check("mic: the Mac's mic is silent-checked: sound → fine", silentMicVerdict(sinceMs: 200, peak: 0.002, headsetMicAvailable: true) == .fine)
  check("mic: …digital silence under 1.5 s → wait", silentMicVerdict(sinceMs: 1400, peak: 0, headsetMicAvailable: true) == .wait)
  check("mic: …digital silence for 1.5 s with the headset's mic there → back to it", silentMicVerdict(sinceMs: 1500, peak: 0, headsetMicAvailable: true) == .fallBack)
  check("mic: …but with no headset mic to go back to, stay", silentMicVerdict(sinceMs: 3000, peak: 0, headsetMicAvailable: false) == .fine)

  // Review round 1: the start ladder — stereo + echo cancellation → the headset's mic → mono → no echo
  // cancellation (bug 103), every level reachable on a stereo output, each forced to fail in turn.
  struct Refused: Error {}
  let full = startLadder(stereo: true, voiceProcessing: true, micOverride: true)
  check("ladder: all four levels on a stereo output with echo cancellation and the Mac's mic — the headset's mic before mono", full == [.asBuilt, .headsetMic, .mono, .noEchoCancellation])
  for k in 0..<full.count {
    var tried: [StartStep] = []
    let reached = try? climbLadder(full) { step in tried.append(step); if tried.count <= k { throw Refused() } }
    check("ladder: the first \(k) level(s) refuse → it starts at \(full[k].rawValue), having tried them in order", reached == full[k] && tried == Array(full.prefix(k + 1)))
  }
  var triedAll: [StartStep] = []
  check("ladder: every level refuses → the error goes up (the call ends with its reason)", (try? climbLadder(full) { triedAll.append($0); throw Refused() }) == nil && triedAll == full)
  check("ladder: a 1:1 call (mono) with echo cancellation has just the plain fallback", startLadder(stereo: false, voiceProcessing: true, micOverride: false) == [.asBuilt, .noEchoCancellation])
  check("ladder: stereo without echo cancellation → mono only", startLadder(stereo: true, voiceProcessing: false, micOverride: false) == [.asBuilt, .mono])

  // Review round 1: a Bot's seat is freed when it leaves, and a player still talking is never handed to another Bot.
  do {
    let bank = SeatBank()
    var busySet = Set<ObjectIdentifier>()
    let inUse = { (p: AVAudioPlayerNode) in busySet.contains(ObjectIdentifier(p)) }
    let first = (0..<6).compactMap { bank.player(for: "bot\($0)", azimuth: 0, inUse: inUse) }
    check("seat bank: six Bots, six different players", Set(first.map(ObjectIdentifier.init)).count == 6)
    check("seat bank: a Bot keeps its player", bank.player(for: "bot2", azimuth: 10, inUse: inUse) === first[2])
    for p in first { busySet.insert(ObjectIdentifier(p)) }
    check("seat bank: a seventh Bot while all six are talking gets no seat (never a shared player)", bank.player(for: "bot6", azimuth: 0, inUse: inUse) == nil)
    bank.release(except: ["bot0", "bot1", "bot2", "bot3", "bot4"], inUse: inUse)
    check("seat bank: a Bot that left keeps its player while it's still talking", bank.owner(of: first[5]) == "bot5")
    busySet.remove(ObjectIdentifier(first[5]))
    bank.release(except: ["bot0", "bot1", "bot2", "bot3", "bot4"], inUse: inUse)
    check("seat bank: …and frees it once quiet", bank.owner(of: first[5]) == nil)
    check("seat bank: the freed player goes to the next Bot", bank.player(for: "bot6", azimuth: 0, inUse: inUse) === first[5])
  }

  // This Mac's own output right now, read from CoreAudio the way a call reads it (no audio is opened).
  let devs = listDevices()
  if let out = defaultDevice(.output, devs) {
    let r = outputRoute(out)
    let inDev = defaultDevice(.input, devs)
    report["thisMac"] = ["output": out.name, "transport": r.transport, "channels": r.channels, "dataSource": r.dataSource.map { String(format: "%08x", $0) } ?? "none",
                         "voices": routeMode(r).rawValue, "input": inDev?.name ?? "none",
                         "micKeepingStereo": micKeepingStereo(input: inDev, output: out, outputChannels: r.channels, devices: devs, lidClosed: lidClosed())?.name ?? "no change", "lidClosed": lidClosed()]
    check("route: this Mac's default output reads as a route (\(out.name): \(r.transport), \(r.channels) ch → \(routeMode(r).rawValue))", r.channels > 0)
  }

  // ---- 3. seat maths ----
  let pans = [-60.0, -40, -30, 0, 30, 40, 60].map { SeatMath.pan(azimuth: $0) }
  check("seats: speakers' pan rises left to right, ±60° = today's ±0.4, centre = 0", zip(pans, pans.dropFirst()).allSatisfy { $0 < $1 } && abs(pans[0] + 0.4) < 1e-9 && abs(pans[6] - 0.4) < 1e-9 && pans[3] == 0)
  check("seats: a legacy pan maps back to its angle", abs(SeatMath.azimuth(pan: SeatMath.pan(azimuth: 30)) - 30) < 1e-6 && SeatMath.azimuth(pan: 0) == 0)
  let p40 = SeatMath.position(azimuth: -40)
  check("seats: -40° is left and in front, 1.2 m away", p40.x < 0 && p40.z < 0 && p40.y == 0 && abs(Double(p40.x * p40.x + p40.z * p40.z).squareRoot() - 1.2) < 1e-4)
  check("seats: the loudness-matching gain is +1.9…+3.1 dB and interpolates", abs(20 * log10(Double(SeatMath.gain(azimuth: 0))) - 3.05) < 0.01 && abs(20 * log10(Double(SeatMath.gain(azimuth: 35))) - 2.51) < 0.01)

  // ---- 4. the graph, rendered offline ----
  /// A line's audio (mono float at its own rate): a recording, or speech-shaped noise (pink noise with a
  /// syllable-rate envelope) at Kokoro's level (RMS 0.064 over voiced samples, bug 190's measurement).
  let files: [String] = {
    guard let i = CommandLine.arguments.firstIndex(of: "--speech"), i + 1 < CommandLine.arguments.count else { return [] }
    return CommandLine.arguments[i + 1].split(separator: ",").map(String.init)
  }()
  /// `--seat-mode speakers` renders the seats with the old level-only pan instead (the before / RED run).
  let seatMode: RouteMode = {
    guard let i = CommandLine.arguments.firstIndex(of: "--seat-mode"), i + 1 < CommandLine.arguments.count else { return .headphones }
    return RouteMode(rawValue: CommandLine.arguments[i + 1]) ?? .headphones
  }()
  report["seatMode"] = seatMode.rawValue
  let outDir: String? = {
    guard let i = CommandLine.arguments.firstIndex(of: "--out"), i + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[i + 1]
  }()
  func pinkish(_ n: Int, seed: UInt64) -> [Float] {
    var s = seed
    var b = [Float](repeating: 0, count: 7)
    var out = [Float](repeating: 0, count: n)
    for i in 0..<n {
      s = s &* 6364136223846793005 &+ 1442695040888963407
      let w = Float(Int64(bitPattern: s >> 11) % 1_000_000) / 500_000 - 1
      b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.96900 * b[2] + w * 0.1538520
      b[3] = 0.86650 * b[3] + w * 0.3104856; b[4] = 0.55000 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.0168980
      let env = Float(0.55 + 0.45 * sin(2 * Double.pi * 4 * Double(i) / 24000))
      out[i] = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * env
      b[6] = w * 0.115926
    }
    return out
  }
  func level(_ x: [Float], rms target: Float) -> [Float] {
    let voiced = x.filter { abs($0) > 0.003 }
    let r = (voiced.reduce(0) { $0 + $1 * $1 } / Float(max(voiced.count, 1))).squareRoot()
    return r > 0 ? x.map { $0 * target / r } : x
  }
  func load(_ path: String) -> (AVAudioFormat, [Float])? {
    guard let f = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
          let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)), (try? f.read(into: b)) != nil,
          let ch = b.floatChannelData else { return nil }
    let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: f.processingFormat.sampleRate, channels: 1, interleaved: false)!
    return (fmt, Array(UnsafeBufferPointer(start: ch[0], count: Int(b.frameLength))))
  }
  let kokoro24 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
  var lines: [(fmt: AVAudioFormat, x: [Float], name: String)] = []
  for (k, path) in files.enumerated() {
    if let (fmt, x) = load(path) { lines.append((fmt, level(x, rms: 0.064), (path as NSString).lastPathComponent.replacingOccurrences(of: ".aiff", with: ""))) }
    else { check("speech file \(k + 1) loads (\(path))", false) }
  }
  // Speech-shaped noise, always: the timing checks need lines with no silences of their own.
  let noise: [(fmt: AVAudioFormat, x: [Float], name: String)] = (0..<3).map { k in (kokoro24, level(pinkish(24000 * 3, seed: UInt64(11 + k)), rms: 0.064), "noise\(k + 1)") }
  if lines.isEmpty { lines = noise }
  while lines.count < 3 { lines.append(lines[lines.count % max(lines.count, 1)]) }
  report["input"] = files.isEmpty ? "speech-shaped noise at Kokoro's level" : "recordings, levelled to Kokoro's RMS 0.064"

  final class Rig { let e: AVAudioEngine; let direct: AVAudioPlayerNode; let bank: SeatBank?; let sp: Speaker
    init(e: AVAudioEngine, direct: AVAudioPlayerNode, bank: SeatBank?, sp: Speaker) { self.e = e; self.direct = direct; self.bank = bank; self.sp = sp } }
  /// A call's graph: stereo with the seats (today's group call + bug 213), or today's 1:1 mono path.
  func rig(stereo st: Bool, mode: RouteMode = .headphones) -> Rig? {
    let e = AVAudioEngine()
    let direct = AVAudioPlayerNode()
    e.attach(direct)
    let fmt = st ? stereo : mono48
    do { try e.enableManualRenderingMode(.offline, format: fmt, maximumFrameCount: 4800) } catch { log("offline engine: \(error)"); return nil }
    e.connect(direct, to: e.mainMixerNode, format: fmt)
    var bank: SeatBank?
    if st { let b = SeatBank(); b.wire(into: e, mixer: e.mainMixerNode, output: stereo); bank = b }
    e.connect(e.mainMixerNode, to: e.outputNode, format: fmt)
    do { try e.start() } catch { log("offline engine start: \(error)"); return nil }
    direct.play()
    bank?.playAll()
    let sp = Speaker(player: direct, format: fmt, engineRunning: { e.isRunning }, playedBack: .dataRendered)
    sp.setOutput(format: fmt, seats: bank, mode: st ? mode : .centre)
    return Rig(e: e, direct: direct, bank: bank, sp: sp)
  }
  /// Renders in 5.3 ms slices, letting the pipeline queue run between them as it would in real time;
  /// `paced`: at real time too (AVFoundation's completion callbacks arrive on their own thread, a
  /// millisecond or so after the render that consumed the buffer — faster than real time, that
  /// millisecond would count as many slices of audio).
  func render(_ r: Rig, seconds: Double, paced: Bool = false, until: (() -> Bool)? = nil) -> ([Float], [Float]) {
    var L: [Float] = [], R: [Float] = []
    guard let b = AVAudioPCMBuffer(pcmFormat: r.e.manualRenderingFormat, frameCapacity: 256) else { return ([], []) }
    var left = Int(seconds * rate)
    while left > 0 {
      guard (try? r.e.renderOffline(AVAudioFrameCount(min(256, left)), to: b)) == .success, let f = b.floatChannelData else { break }
      let n = Int(b.frameLength)
      L += UnsafeBufferPointer(start: f[0], count: n)
      R += UnsafeBufferPointer(start: f[b.format.channelCount > 1 ? 1 : 0], count: n)
      left -= n
      if paced { Thread.sleep(forTimeInterval: Double(n) / rate) }
      q.sync {}
      if let until, until() { break }
    }
    return (L, R)
  }
  func feed(_ r: Rig, id: String, _ line: (fmt: AVAudioFormat, x: [Float], name: String), azimuth: Double?, seat: String?, queue: Bool = false, pauseMs: Double = 0) {
    q.sync {
      r.sp.speak(id: id, text: "line", voice: nil, rate: nil, lang: nil, queue: queue, engine: "pcm", pauseMs: pauseMs, azimuth: azimuth, seat: seat)
      let chunk = Int(line.fmt.sampleRate / 2) // 0.5 s, as the app sends Kokoro's chunks
      var at = 0
      while at < line.x.count {
        let n = min(chunk, line.x.count - at)
        let b = AVAudioPCMBuffer(pcmFormat: line.fmt, frameCapacity: AVAudioFrameCount(n))!
        b.frameLength = AVAudioFrameCount(n)
        line.x.withUnsafeBufferPointer { b.floatChannelData![0].update(from: $0.baseAddress! + at, count: n) }
        r.sp.pcm(id: id, buffer: b)
        at += n
      }
      r.sp.pcmEnd(id: id)
    }
  }
  // Measures.
  func kweight(_ x: [Float]) -> [Float] {
    func bq(_ x: [Float], _ b: [Double], _ a: [Double]) -> [Float] {
      var y = [Float](repeating: 0, count: x.count); var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
      for i in 0..<x.count { let xi = Double(x[i]); let yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = Float(yi) }
      return y
    }
    return bq(bq(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]), [1, -2, 1], [1, -1.99004745483398, 0.99007225036621])
  }
  /// ITU-R BS.1770 integrated loudness (LUFS), gated, 48 kHz.
  func lufs(_ chans: [[Float]]) -> Double {
    let k = chans.map(kweight)
    let n = k[0].count, blk = Int(0.4 * rate), hop = Int(0.1 * rate)
    var z: [Double] = []
    var st = 0
    while st + blk <= n {
      var s = 0.0
      for c in k { var e = 0.0; for i in st..<(st + blk) { e += Double(c[i] * c[i]) }; s += e / Double(blk) }
      z.append(s); st += hop
    }
    let lk = { (v: Double) in -0.691 + 10 * log10(v + 1e-20) }
    let a = z.filter { lk($0) > -70 }
    let rel = lk(a.reduce(0, +) / Double(max(a.count, 1))) - 10
    let g = a.filter { lk($0) > rel }
    return lk(g.reduce(0, +) / Double(max(g.count, 1)))
  }
  func onePole(_ x: [Float], _ fc: Double, high: Bool) -> [Float] {
    let a = exp(-2 * Double.pi * fc / rate)
    var y = x
    for _ in 0..<2 { var s = 0.0; for i in 0..<y.count { s = (1 - a) * Double(y[i]) + a * s; y[i] = high ? Float(Double(y[i]) - s) : Float(s) } }
    return y
  }
  func energy(_ x: [Float]) -> Double { x.reduce(0.0) { $0 + Double($1) * Double($1) } }
  /// The lag (samples) of R against L at the peak of their cross-correlation, within ±1 ms (48 samples),
  /// on the band under 1.2 kHz where the time difference is what the ear uses. Positive = R later (source left).
  func itd(_ l: [Float], _ r: [Float]) -> Int {
    let a = onePole(l, 1200, high: false), b = onePole(r, 1200, high: false), m = 48
    var best = 0, bv = -Double.infinity
    for lag in -m...m {
      var s = 0.0
      var i = m
      while i < a.count - m { s += Double(a[i]) * Double(b[i + lag]); i += 1 }
      if s > bv { bv = s; best = lag }
    }
    return best
  }
  func peak(_ x: [Float]) -> Float { x.reduce(0) { max($0, abs($1)) } }
  func firstSound(_ l: [Float], _ r: [Float], above t: Float = 1e-3) -> Int { l.indices.first { abs(l[$0]) > t || abs(r[$0]) > t } ?? -1 }
  func writeWav(_ name: String, _ l: [Float], _ r: [Float]) {
    guard let dir = outDir else { return }
    let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
    let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
    guard let f = try? AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false),
          let b = AVAudioPCMBuffer(pcmFormat: stereo, frameCapacity: AVAudioFrameCount(l.count)) else { log("couldn't write \(url.path)"); return }
    b.frameLength = AVAudioFrameCount(l.count)
    l.withUnsafeBufferPointer { b.floatChannelData![0].update(from: $0.baseAddress!, count: l.count) }
    r.withUnsafeBufferPointer { b.floatChannelData![1].update(from: $0.baseAddress!, count: r.count) }
    do { try f.write(from: b) } catch { log("couldn't write \(url.path): \(error)") }
  }
  func r2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

  // 4a. Each Bot alone at its seat (3 Bots: -40 / 0 / +40), against the same line centred in both ears —
  //     the level every call has had (today's centre seat and today's 1:1 voice).
  let arc = [-40.0, 0, 40]
  var rows: [[String: Any]] = []
  var ilds: [Double] = [], itds: [Int] = [], louds: [Double] = []
  var maxPeak: Float = 0
  for (k, az) in arc.enumerated() {
    let line = lines[k]
    guard let ref = rig(stereo: true), let seat = rig(stereo: true, mode: seatMode) else { check("offline engines start", false); continue }
    feed(ref, id: "ref\(k)", line, azimuth: nil, seat: nil)
    let (rl, rr) = render(ref, seconds: Double(line.x.count) / line.fmt.sampleRate + 0.3)
    feed(seat, id: "seat\(k)", line, azimuth: az, seat: "bot\(k)")
    let (sl, sr) = render(seat, seconds: Double(line.x.count) / line.fmt.sampleRate + 0.3)
    let ild = 10 * log10(energy(sl) / max(energy(sr), 1e-20))
    let ildHF = 10 * log10(energy(onePole(sl, 2000, high: true)) / max(energy(onePole(sr, 2000, high: true)), 1e-20))
    let lag = itd(sl, sr)
    let loud = lufs([sl, sr]) - lufs([rl, rr])
    let pk = max(peak(sl), peak(sr)), refPk = max(peak(rl), peak(rr))
    maxPeak = max(maxPeak, pk)
    ilds.append(ild); itds.append(lag); louds.append(loud)
    rows.append(["bot": line.name, "azimuth": az, "ildDb": r2(ild), "ildAbove2kHzDb": r2(ildHF), "itdSamples": lag, "itdMs": r2(Double(lag) / 48 * 100) / 100,
                 "loudnessVsCentreLU": r2(loud), "peak": r2(Double(pk)), "centrePeak": r2(Double(refPk)), "centreLUFS": r2(lufs([rl, rr]))])
    log(String(format: "seat %+.0f° (%@): ILD %+.2f dB (>2 kHz %+.2f), ITD %d samples (%.3f ms), loudness %+.2f LU vs centre, peak %.3f (centre %.3f)", az, line.name, ild, ildHF, lag, Double(lag) / 48, loud, pk, refPk))
    writeWav("seat-\(k + 1)-\(az < 0 ? "left" : az > 0 ? "right" : "centre")-\(line.name).wav", sl, sr)
    writeWav("centre-reference-\(line.name).wav", rl, rr)
  }
  report["seats"] = rows
  if ilds.count == 3 {
    check("seats: the level difference moves left → right monotonically (\(ilds.map { r2($0) }) dB, L−R)", ilds[0] > ilds[1] && ilds[1] > ilds[2] && ilds[0] > 2 && ilds[2] < -2)
    check("seats: the time difference moves left → right monotonically (\(itds) samples, R after L)", itds[0] > itds[1] && itds[1] > itds[2] && itds[0] >= 10 && itds[2] <= -10 && abs(itds[1]) <= 2)
    check("seats: every seat is as loud as today's centred voice, ±1 dB (\(louds.map { r2($0) }) LU)", louds.allSatisfy { abs($0) <= 1 })
    check("seats: no clipping (peak \(r2(Double(maxPeak))))", maxPeak < 1)
  }

  // 4b. A hot line (peaks at −0.4 dBFS, far above Kokoro) on the widest seat: the seat gain gives way
  //     rather than the output clipping.
  if let r = rig(stereo: true) {
    let hot = (lines[0].fmt, { let p = peak(lines[0].x); return lines[0].x.map { $0 * 0.955 / p } }(), "hot")
    feed(r, id: "hot", hot, azimuth: -60, seat: "hot")
    let (l, rr) = render(r, seconds: Double(hot.1.count) / hot.0.sampleRate + 0.3)
    let pk = max(peak(l), peak(rr))
    report["hotLinePeak"] = r2(Double(pk))
    check("seats: a line peaking at −0.4 dBFS on the ±60° seat still doesn't clip (peak \(r2(Double(pk))))", pk < 1)
  }

  // 4c. Three Bots talking in turn (each line ends in its 250 ms pause): one voice at a time, every
  //     change of speaker exactly the pause (plus at most one render cycle), nothing lost.
  if !files.isEmpty, let r = rig(stereo: true) {
    for (k, az) in arc.enumerated() { feed(r, id: "c\(k)", lines[k], azimuth: az, seat: "bot\(k)", queue: k > 0, pauseMs: 250) }
    let total = lines.prefix(3).reduce(0.0) { $0 + Double($1.x.count) / $1.fmt.sampleRate + 0.25 }
    let (l, rr) = render(r, seconds: total + 0.5)
    writeWav("conversation-3-bots.wav", l, rr)
    let heard = l.indices.filter { abs(l[$0]) > 1e-3 || abs(rr[$0]) > 1e-3 }.count
    report["conversationSeconds"] = r2(Double(l.count) / rate)
    report["conversationAudibleSeconds"] = r2(Double(heard) / rate)
  }
  if let r = rig(stereo: true) {
    let lines = noise.map { n in (fmt: n.fmt, x: Array(n.x.prefix(Int(n.fmt.sampleRate * 1.5))), name: n.name) }
    for (k, az) in arc.enumerated() { feed(r, id: "c\(k)", lines[k], azimuth: az, seat: "bot\(k)", queue: k > 0, pauseMs: 250) }
    let total = lines.prefix(3).reduce(0.0) { $0 + Double($1.x.count) / $1.fmt.sampleRate + 0.25 }
    let (l, rr) = render(r, seconds: total + 0.5, paced: true)
    do {
      // Speech-shaped noise has no pauses of its own: every silence ≥ 150 ms is a change of speaker.
      var gaps: [Double] = []
      var run = 0
      let start = firstSound(l, rr)
      for i in max(start, 0)..<l.count {
        if abs(l[i]) < 1e-4 && abs(rr[i]) < 1e-4 { run += 1 } else { if run >= 7200 { gaps.append(Double(run) / 48) }; run = 0 }
      }
      report["speakerChangeGapsMs"] = gaps.map { r2($0) }
      check("turns: two changes of speaker, each the 250 ms pause + ≤ 12 ms (\(gaps.map { r2($0) }) ms)", gaps.count == 2 && gaps.allSatisfy { $0 >= 245 && $0 <= 262 })
      // Where each Bot is while it talks: the middle of each turn leans the right way.
      let n = l.count
      var sides: [Double] = []
      for (k, _) in arc.enumerated() {
        let len = Int(Double(lines[k].x.count) / lines[k].fmt.sampleRate * rate)
        let off = start + lines.prefix(k).reduce(0) { $0 + Int(Double($1.x.count) / $1.fmt.sampleRate * rate) + 12000 }
        let a = min(off + len / 4, n), b = min(off + 3 * len / 4, n)
        sides.append(10 * log10(energy(Array(l[a..<b])) / max(energy(Array(rr[a..<b])), 1e-20)))
      }
      check("turns: each Bot is heard from its own seat while it talks (\(sides.map { r2($0) }) dB, L−R)", sides.count == 3 && sides[0] > 2 && abs(sides[1]) < 1 && sides[2] < -2)
    }
    let heard = l.indices.filter { abs(l[$0]) > 1e-3 || abs(rr[$0]) > 1e-3 }.count
    let expected = lines.prefix(3).reduce(0) { $0 + Int(Double($1.x.count) / $1.fmt.sampleRate * rate) }
    check("turns: all three lines play in full (\(heard) of ~\(expected) samples audible)", Double(heard) >= Double(expected) * 0.97 && Double(heard) <= Double(expected) * 1.02)
  }

  // 4d. Bug 188 on a seat: a barge-in fades the Bot (at its seat) within ~150 ms, and the next Bot's
  //     line, on another seat, plays at full level. Rendered at about real time (the fade runs on the clock).
  if let r = rig(stereo: true) {
    var ended: [String] = []
    r.sp.onEnd = { ended.append($0) }
    feed(r, id: "f1", noise[0], azimuth: -40, seat: "bot0")
    guard let rb = AVAudioPCMBuffer(pcmFormat: r.e.manualRenderingFormat, frameCapacity: 240) else { exit(1) }
    func slice() -> Float {
      guard (try? r.e.renderOffline(240, to: rb)) == .success, let f = rb.floatChannelData else { return 0 }
      return (0..<Int(rb.frameLength)).map { max(abs(f[0][$0]), abs(f[1][$0])) }.max() ?? 0
    }
    var before: Float = 0
    for _ in 0..<60 { before = max(before, slice()); Thread.sleep(forTimeInterval: 0.005) }
    q.sync { r.sp.stop(interrupted: true) }
    check("seat barge-in: the line ends at once (\(ended))", ended == ["f1"])
    var peaks: [Float] = []
    for _ in 0..<60 { peaks.append(slice()); Thread.sleep(forTimeInterval: 0.005) }
    let last = peaks.lastIndex { $0 > 0.001 } ?? -1
    report["bargeInFadeMs"] = (last + 1) * 5
    check("seat barge-in: fades rather than stops dead (sounds \((last + 1) * 5) ms after the stop)", last >= 5)
    check("seat barge-in: …and is gone within ~150 ms (\((last + 1) * 5) ms)", last < 30)
    check("seat barge-in: …getting quieter as it goes (last \(last >= 0 ? peaks[last] : 0) of \(before))", last >= 1 && peaks[last] < before * 0.5)
    feed(r, id: "f2", noise[2], azimuth: 40, seat: "bot2")
    var loud = 0
    var p2: [Float] = []
    for _ in 0..<60 { let v = slice(); p2.append(v); if v > before * 0.3 { loud += 1 }; Thread.sleep(forTimeInterval: 0.005) }
    check("seat barge-in: the next Bot's line (another seat) plays at full level (\(loud) loud slices of 60)", loud >= 40)
  }

  // 4e. A restart (a configuration change) mid-line on a seat replays what hadn't played (bug 141).
  if let r = rig(stereo: true) {
    feed(r, id: "rs", noise[1], azimuth: 40, seat: "bot1")
    let (l1, r1) = render(r, seconds: 0.6)
    q.sync { r.sp.pathStopping() }
    r.e.stop()
    try? r.e.start()
    r.direct.play()
    r.bank?.playAll()
    q.sync { r.sp.pathStarted(settleMs: 0) }
    let (l2, r2x) = render(r, seconds: Double(noise[1].x.count) / noise[1].fmt.sampleRate + 0.5)
    let heard = (l1 + l2).indices.filter { i in let a = i < l1.count ? max(abs(l1[i]), abs(r1[i])) : max(abs(l2[i - l1.count]), abs(r2x[i - l1.count])); return a > 1e-3 }.count
    let expected = Int(Double(noise[1].x.count) / noise[1].fmt.sampleRate * rate)
    check("seat restart: all of the line plays across the restart (\(heard) of ~\(expected) audible)", Double(heard) >= Double(expected) * 0.95)
  }

  // 4e'. Review round 1: a switch marker that is never consumed (here: nothing renders at all) doesn't
  //      hold the next Bot's line for good — it goes out once the old line should long have played.
  if let r = rig(stereo: true) {
    let short = (fmt: noise[0].fmt, x: Array(noise[0].x.prefix(Int(noise[0].fmt.sampleRate * 0.2))), name: "short")
    // The first line is near-silent, so the second Bot's voice is recognisable even if they overlap.
    feed(r, id: "m1", (fmt: short.fmt, x: short.x.map { $0 * 0.01 }, name: "quiet"), azimuth: -40, seat: "bot0")
    feed(r, id: "m2", short, azimuth: 40, seat: "bot2", queue: true)
    Thread.sleep(forTimeInterval: 2.5) // 0.2 s of line + the 2 s margin, with no render in between
    q.sync {}
    // Without the timeout the second line could only start after the first 0.2 s had rendered; with it,
    // it is already on its player and sounds from the very first 0.1 s.
    let (l, rr) = render(r, seconds: 0.1)
    let right = (0..<l.count).filter { abs(rr[$0]) > abs(l[$0]) * 1.5 && abs(rr[$0]) > 1e-3 }.count
    check("switch: an unconsumed marker times out and the next Bot's line goes out (\(right) right-seat samples in the first 0.1 s)", right > 1500)
  }

  // 4f. First-audio latency: from the speak line (and its first chunk) to the first sound out — the
  //     scheduling path on the clock, and the render path in samples. Today's 1:1 path (mono), the new
  //     1:1 path (stereo, centred) and a headphone seat.
  var lat: [String: Any] = [:]
  var schedMs: [String: Double] = [:], renderMs: [String: Double] = [:]
  for (name, st, az) in [("today-1to1-mono", false, nil), ("new-1to1-stereo", true, nil), ("new-seat-hrtf", true, -40.0)] as [(String, Bool, Double?)] {
    var sched: [Double] = [], rend: [Double] = []
    for trial in 0..<5 {
      guard let r = rig(stereo: st) else { continue }
      let t0 = nowMs()
      feed(r, id: "lat\(trial)", (kokoro24, Array(noise[0].x.prefix(12000)), "lat"), azimuth: az, seat: az == nil ? nil : "bot0")
      var at = 0.0
      q.sync { at = r.sp.audibleSince }
      sched.append(at - t0)
      let (l, rr) = render(r, seconds: 0.4)
      rend.append(Double(firstSound(l, rr, above: 1e-4)) / 48)
    }
    let med = { (x: [Double]) -> Double in x.sorted()[x.count / 2] }
    schedMs[name] = med(sched); renderMs[name] = med(rend)
    lat[name] = ["scheduleMsMedian": r2(med(sched)), "firstSoundMsMedian": r2(med(rend))]
  }
  report["firstAudio"] = lat
  if let a = schedMs["today-1to1-mono"], let b = schedMs["new-seat-hrtf"], let c = schedMs["new-1to1-stereo"],
     let ra = renderMs["today-1to1-mono"], let rb = renderMs["new-seat-hrtf"], let rc = renderMs["new-1to1-stereo"] {
    check("latency: first audio on a seat is today's ±10 ms (schedule \(r2(a)) → \(r2(b)) ms; render \(r2(ra)) → \(r2(rb)) ms)", abs(b - a) <= 10 && abs(rb - ra) <= 10)
    check("latency: …and on the new stereo 1:1 path (schedule \(r2(c)) ms; render \(r2(rc)) ms)", abs(c - a) <= 10 && abs(rc - ra) <= 10)
  }

  // 4g. CPU: rendering 10 s through each graph, as a fraction of real time.
  var cpu: [String: Double] = [:]
  for (name, st, az) in [("today-1to1-mono", false, nil), ("stereo-6-seats-idle", true, nil), ("stereo-seat-speaking", true, -40.0)] as [(String, Bool, Double?)] {
    guard let r = rig(stereo: st) else { continue }
    let long = (kokoro24, Array(repeating: noise[0].x, count: 5).flatMap { $0 }, "long")
    feed(r, id: "cpu", long, azimuth: az, seat: az == nil ? nil : "bot0")
    guard let b = AVAudioPCMBuffer(pcmFormat: r.e.manualRenderingFormat, frameCapacity: 512) else { continue }
    let t0 = Date()
    for _ in 0..<(480000 / 512) { _ = try? r.e.renderOffline(512, to: b) }
    cpu[name] = Date().timeIntervalSince(t0) / 10
  }
  report["cpuFractionOfRealtime"] = cpu.mapValues { ($0 * 100000).rounded() / 100000 }
  log("cpu (fraction of real time): \(cpu)")

  report["ok"] = failures.isEmpty
  report["failures"] = failures
  if let dir = outDir, let d = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
    try? d.write(to: URL(fileURLWithPath: dir).appendingPathComponent("report.json"))
  }
  emit(["type": "self-test", "ok": failures.isEmpty, "cases": cases, "failures": failures, "report": report])
  exit(failures.isEmpty ? 0 : 1)
}

/// --self-test-devices: the pure selection logic, plus one real CoreAudio round trip.
func runDeviceSelfTest() -> Never {
  var cases = 0
  var failures: [String] = []
  func check(_ name: String, _ ok: Bool) { cases += 1; if !ok { failures.append(name) } }
  let mic = AudioDev(id: 10, uid: "USB-MIC", name: "USB Mic", input: true, output: false, transport: "usb")
  let spk = AudioDev(id: 11, uid: "BT-SPK", name: "Headphones", input: false, output: true, transport: "bluetooth")
  let builtIn = AudioDev(id: 1, uid: "BuiltIn", name: "Built-in", input: true, output: true, transport: "built-in")

  let none = DeviceChoice(kind: .input, preferred: nil)
  let r0 = none.update([mic, builtIn], defaultName: "Built-in")
  check("no preference follows the default", r0.event == nil && !r0.rebuild && none.active == nil)

  let c = DeviceChoice(kind: .input, preferred: "USB-MIC")
  let r1 = c.update([mic, builtIn], defaultName: "Built-in")
  check("a present device is selected", r1.event == nil && !r1.rebuild && c.active?.id == 10)
  let r2 = c.update([builtIn], defaultName: "Built-in")
  check("unplugged mid-session falls back and rebuilds", r2.rebuild && c.active == nil && r2.event?["type"] as? String == "device-fallback"
    && r2.event?["name"] as? String == "USB Mic" && r2.event?["fallback"] as? String == "Built-in" && r2.event?["kind"] as? String == "input")
  let r3 = c.update([builtIn], defaultName: "Built-in")
  check("a missing device is reported once", r3.event == nil && !r3.rebuild)
  let back = AudioDev(id: 20, uid: "USB-MIC", name: "USB Mic", input: true, output: false, transport: "usb")
  let r4 = c.update([builtIn, back], defaultName: "Built-in")
  check("a returning device is selected again", r4.rebuild && c.active?.id == 20 && r4.event?["type"] as? String == "device-restored")

  let late = DeviceChoice(kind: .output, preferred: "BT-SPK")
  let r5 = late.update([builtIn], defaultName: "Built-in")
  check("missing at start: fallback reported, no rebuild", !r5.rebuild && late.active == nil && r5.event?["type"] as? String == "device-fallback" && r5.event?["uid"] as? String == "BT-SPK")

  let wrongWay = DeviceChoice(kind: .input, preferred: "BT-SPK")
  let r6 = wrongWay.update([spk, builtIn], defaultName: "Built-in")
  check("an output-only device can't be the microphone", wrongWay.active == nil && r6.event?["type"] as? String == "device-fallback")

  let re = DeviceChoice(kind: .output, preferred: "BT-SPK")
  _ = re.update([spk], defaultName: "")
  let moved = AudioDev(id: 33, uid: "BT-SPK", name: "Headphones", input: false, output: true, transport: "bluetooth")
  let r7 = re.update([moved], defaultName: "")
  check("a re-enumerated device rebuilds quietly", r7.rebuild && r7.event == nil && re.active?.id == 33)

  check("transport names", transportName(kAudioDeviceTransportTypeUSB) == "usb" && transportName(kAudioDeviceTransportTypeBluetooth) == "bluetooth"
    && transportName(kAudioDeviceTransportTypeBuiltIn) == "built-in" && transportName(fourCC("zzzz")) == "unknown")
  check("private aggregates are hidden", isPrivateAggregate(uid: "VPAUAggregateAudioDevice-0x1") && isPrivateAggregate(uid: "CADefaultDeviceAggregate-123-4") && !isPrivateAggregate(uid: "My Aggregate"))
  let j = deviceJSON(builtIn, defIn: 1, defOut: 99)
  check("device JSON", j["uid"] as? String == "BuiltIn" && j["defaultInput"] as? Bool == true && j["defaultOutput"] as? Bool == false
    && JSONSerialization.isValidJSONObject(["type": "devices", "devices": [j]]))

  // Bug 196: the microphone tap plan — never an install the engine would abort on.
  let hw48 = TapFormatInfo(rate: 48000, channels: 1), hw24 = TapFormatInfo(rate: 24000, channels: 1)
  let zero = TapFormatInfo(rate: 0, channels: 0), noCh = TapFormatInfo(rate: 48000, channels: 0)
  check("tap: node agrees with the hardware → node format", planTap(hardware: hw48, node: hw48, strictRate: true) == .node)
  check("tap: route change left a stale node rate → hardware format", planTap(hardware: hw24, node: hw48, strictRate: true) == .hardware)
  check("tap: node reports nothing but the hardware is fine → hardware format", planTap(hardware: hw48, node: zero, strictRate: true) == .hardware)
  check("tap: device mid-switch (0 Hz) → retry, no install", planTap(hardware: zero, node: hw48, strictRate: true) == .retry)
  check("tap: device mid-switch (0 channels) → retry, no install", planTap(hardware: noCh, node: hw48, strictRate: true) == .retry)
  check("tap: voice processing keeps its own client format", planTap(hardware: TapFormatInfo(rate: 48000, channels: 1), node: TapFormatInfo(rate: 44100, channels: 9), strictRate: false) == .node)
  check("tap: voice processing with no client format → retry", planTap(hardware: hw48, node: zero, strictRate: false) == .retry)
  check("tap: retry backoff 100/250/500/1000 then capped", (0..<8).map { tapRetryDelayMs($0) ?? -1 } == [100, 250, 500, 1000, 1000, 1000, 1000, 1000]
    && tapRetryDelayMs(8) == nil && tapRetryDelayMs(-1) == nil)
  // The stall watchdog vs a pending tap retry: 100 ms ticks through a whole backoff with no audio.
  // While the source is recovering the watchdog neither restarts nor counts; after the backoff
  // succeeds (clock restarts at 0) a real stall restarts as before.
  var outerRestarts = 0
  var t = 0.0
  while t <= 6000 {
    if stallWatchdogRestart(stopping: false, restartPending: false, sourceRecovering: true, gotAudio: false, sinceMs: t) != nil { outerRestarts += 1 }
    t += 100
  }
  check("watchdog: no outer restart while a tap retry is pending (6 s of stall ticks)", outerRestarts == 0)
  check("watchdog: after the retry succeeds, a fresh start isn't a stall", stallWatchdogRestart(stopping: false, restartPending: false, sourceRecovering: false, gotAudio: false, sinceMs: 500) == nil)
  check("watchdog: after the retry succeeds, no audio for 2 s restarts again", stallWatchdogRestart(stopping: false, restartPending: false, sourceRecovering: false, gotAudio: false, sinceMs: 2100) == "no-audio")
  check("watchdog: audio that stalls 1.5 s restarts again", stallWatchdogRestart(stopping: false, restartPending: false, sourceRecovering: false, gotAudio: true, sinceMs: 1600) == "stalled")
  check("watchdog: stopping or a restart already pending never restarts", stallWatchdogRestart(stopping: true, restartPending: false, sourceRecovering: false, gotAudio: true, sinceMs: 9000) == nil
    && stallWatchdogRestart(stopping: false, restartPending: true, sourceRecovering: false, gotAudio: true, sinceMs: 9000) == nil)
  check("tap: a new hardware rate is a route change", inputRouteChanged(last: hw48, now: hw24) && inputRouteChanged(last: hw48, now: TapFormatInfo(rate: 48000, channels: 2)))
  check("tap: same format, first start, or a device mid-switch is not", !inputRouteChanged(last: hw48, now: hw48) && !inputRouteChanged(last: nil, now: hw24) && !inputRouteChanged(last: hw48, now: zero))
  // Restart with a tap already on the bus: installTapSafely twice on a real (offline) engine node.
  // Without the removeTap first, the second install raises an NSException and this process aborts.
  do {
    let e = AVAudioEngine()
    let f = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    try e.enableManualRenderingMode(.offline, format: f, maximumFrameCount: 1024)
    let mixer = e.mainMixerNode
    var taps = 0
    installTapSafely(mixer, format: nil, bufferSize: 1024) { _, _ in }
    taps += 1
    installTapSafely(mixer, format: nil, bufferSize: 1024) { _, _ in }
    taps += 1
    mixer.removeTap(onBus: 0)
    check("tap: a restart with a tap still on the bus doesn't abort", taps == 2)
  } catch {
    check("tap: offline engine for the double-install check (\(error.localizedDescription))", false)
  }

  // Real CoreAudio: the default input (if this Mac has one) is in the list under its own ID.
  let devs = listDevices()
  if let id = defaultDeviceID(.input) {
    check("the default input is listed", devs.contains { $0.id == id && $0.input })
  }
  emit(["type": "self-test", "ok": failures.isEmpty, "cases": cases, "failures": failures])
  exit(failures.isEmpty ? 0 : 1)
}

// ---------- bug 196: installing the microphone tap safely (pure plan, self-tested) ----------
// AVAudioNode.installTap raises an Objective-C NSException — which Swift cannot catch, so the helper
// aborts (SIGABRT) — when the bus already has a tap, when the tap's format no longer matches the
// input HARDWARE (a route change: headphones, AirPods, a pinned device switching rate while the
// graph still reports the old one), or when the input has no channels / no rate (a device mid-switch).
// The wake helper died this way three times in a minute (2026-09-24, headphone-jack mic coming and
// going). Nothing here throws into ObjC: the plan steers around every one of those states instead.
struct TapFormatInfo: Equatable {
  let rate: Double
  let channels: UInt32
  init(rate: Double, channels: UInt32) { self.rate = rate; self.channels = channels }
  init(_ f: AVAudioFormat) { rate = f.sampleRate; channels = f.channelCount }
  var valid: Bool { rate > 0 && channels > 0 }
}
enum TapPlan: Equatable {
  /// Install with the node's own output format (it agrees with the hardware).
  case node
  /// The node's output format is stale (its rate is not the hardware's): tap at the hardware format.
  /// The input converter downstream rebuilds itself for whatever format arrives.
  case hardware
  /// No valid format to tap yet (the device is switching): install nothing, try again shortly.
  case retry
}
/// `strictRate`: without voice processing the input node's tap must run at the hardware rate. The
/// voice-processing unit publishes its own client format (7/9 channels), so there only validity counts.
func planTap(hardware hw: TapFormatInfo, node: TapFormatInfo, strictRate: Bool) -> TapPlan {
  guard hw.valid else { return .retry }
  guard node.valid else { return strictRate ? .hardware : .retry }
  if strictRate && node.rate != hw.rate { return .hardware }
  return .node
}
/// Backoff while the input has no usable format: 100, 250, 500, 1000 ms, then 1000 ms, capped at
/// 8 tries (~5.9 s); nil = give up and let the pipeline's bounded restart / clean "no-audio" handle it.
/// Statics, not globals: the self-tests run before the top-level globals are initialized.
enum TapTiming {
  static let retryMs = [100, 250, 500, 1000]
  static let maxRetries = 8
  /// Bursts of AVAudioEngineConfigurationChange (a route change posts several) become one restart.
  static let configChangeDebounceMs = 200
}
/// The pipeline's stall watchdog: the restart reason, or nil. While the source is inside its own tap
/// retry backoff it neither counts nor restarts — an outer restart would supersede the backoff and it
/// would never play out. When the backoff succeeds (the watchdog clock starts over) or gives up (a
/// clean no-audio), the watchdog is back to normal.
func stallWatchdogRestart(stopping: Bool, restartPending: Bool, sourceRecovering: Bool, gotAudio: Bool, sinceMs: Double) -> String? {
  if stopping || restartPending || sourceRecovering { return nil }
  return sinceMs > (gotAudio ? 1500 : 2000) ? (gotAudio ? "stalled" : "no-audio") : nil
}
func tapRetryDelayMs(_ attempt: Int) -> Int? {
  guard attempt >= 0, attempt < TapTiming.maxRetries else { return nil }
  return TapTiming.retryMs[min(attempt, TapTiming.retryMs.count - 1)]
}
/// A restart after a configuration change: when the input hardware's format moved since the last
/// tap (a route change), the whole path is stopped, reset and rebuilt rather than restarted in place.
func inputRouteChanged(last: TapFormatInfo?, now: TapFormatInfo) -> Bool {
  guard let last, now.valid else { return false }
  return last != now
}
/// Removes any tap on bus 0 first — installing on a bus that has one is itself an NSException.
func installTapSafely(_ node: AVAudioNode, format: AVAudioFormat?, bufferSize: AVAudioFrameCount, _ block: @escaping AVAudioNodeTapBlock) {
  node.removeTap(onBus: 0)
  node.installTap(onBus: 0, bufferSize: bufferSize, format: format, block: block)
}

// ---------- audio sources ----------
enum SourceError: LocalizedError {
  case noInputDevice
  var errorDescription: String? { "No microphone input is available (the input device reports no channels)." }
}
protocol AudioSource: AnyObject {
  var name: String { get }
  var onBuffer: (AVAudioPCMBuffer) -> Void { get set }
  var onInterrupted: (String) -> Void { get set }
  /// The source rebuilt its audio path by itself (a device came or went, or a new choice): audio restarts now.
  var onReconfigured: () -> Void { get set }
  func start() throws
  func restart() throws
  /// Bug 105: a new device choice mid-session (nil = system default), applied without ending the session.
  func switchDevices(input: String?, output: String?) throws
  /// Bug 134: stereo output for spatial voices (group calls), or back to mono.
  func setSpatial(_ on: Bool) throws
  /// Bug 134: a short sound (the join / leave chime) mixed into the call's output.
  func playFx(_ buf: AVAudioPCMBuffer)
  func stop()
  /// Bug 196: the source is inside its own recovery (the tap retry backoff); the stall watchdog waits.
  var recovering: Bool { get }
}
extension AudioSource { var recovering: Bool { false } }

final class MicSource: AudioSource {
  let name = "mic"
  let engine = AVAudioEngine()
  let player = AVAudioPlayerNode()
  /// Bug 134: the join / leave chime's own player, on the same mixer (echo cancellation hears it too).
  let fxPlayer = AVAudioPlayerNode()
  /// 48 kHz mono, or stereo while spatial voices are on (bug 134).
  private(set) var playerFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
  /// Bug 213: the speech output was (re)built or its route changed: the player format, the headphone
  /// seats (nil when the output is mono) and how voices are placed.
  var onOutput: (AVAudioFormat, SeatBank?, RouteMode) -> Void = { _, _, _ in }
  /// Review round 1 (bug 219): the output device's latency (ms) and transport, for the speaker's overrun margin.
  var onOutputLatency: (Double, String) -> Void = { _, _ in }
  /// Bug 134 / 210: a call's output is built in stereo from its start (a second Bot joining never
  /// rebuilds the audio path); mono only when the output device itself is mono (Bluetooth hands-free).
  private var spatialWanted: Bool
  /// Bug 213: the output is stereo right now, and how voices are placed on it.
  private(set) var stereo = false
  private(set) var route: RouteMode = .centre
  /// Bug 213: one HRTF player per Bot, wired in from the start of the call whenever the output is stereo.
  let seats = SeatBank()
  private let spatialRoute: String?
  private var routeDevice: AudioDev?
  private var routeInfo: OutputRoute?
  /// A device whose output wouldn't start in stereo (bug 134): mono on it until the output changes.
  private var stereoFailedFor: String?
  private var routeListeners: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
  private var routeCheckPending = false
  /// Bug 213: the Mac's microphone, opened instead of a Bluetooth headset's own (which would drop the
  /// headset to mono hands-free); nil = the chosen / default microphone as usual.
  private var micOverride: AudioDev?
  /// The headset the override is for: it stays while that headset is the output (no flip-flopping as
  /// the headset goes back to stereo once its microphone is closed).
  private var micOverrideFor: String?
  /// The override is for a classic Bluetooth headset that is on hands-free only because of a microphone:
  /// the output is built in stereo straight away (it leaves hands-free once its mic is closed) rather
  /// than mono and then rebuilt ~0.3 s later when the listener sees it go back to stereo.
  private var predictStereo = false
  /// Review polish: the opposite — the swap was undone on a classic Bluetooth headset, so its own mic
  /// is about to put it on hands-free: build mono now (one rebuild, not stereo and then mono).
  private var predictMono = false
  /// Bug 213 (review): the Mac's mic giving digital silence (a closed lid, a muted or broken mic) is
  /// caught ~1.5 s after the start: back to the headset's mic.
  private var silenceWatchSince: Double?
  private var silenceWatchPeak: Float = 0
  /// Read on the audio thread (the tap), set on q: under its own lock.
  private let watchLock = NSLock()
  private var watchingMic = false
  /// The headset's own mic was there when the watch began (read once, not per tap buffer).
  private var silenceWatchHeadset = false
  private func setSilenceWatch(_ since: Double?) {
    silenceWatchSince = since
    silenceWatchPeak = 0
    if since != nil { silenceWatchHeadset = listDevices().contains { $0.input && $0.transport.hasPrefix("bluetooth") && $0.name == routeDevice?.name } }
    watchLock.lock(); watchingMic = since != nil; watchLock.unlock()
  }
  let voiceProcessing: Bool
  let playback: Bool
  var onBuffer: (AVAudioPCMBuffer) -> Void = { _ in }
  var onInterrupted: (String) -> Void = { _ in }
  var onReconfigured: () -> Void = {}
  /// Bug 141: the engine is about to stop / has started (the speaker holds its audio in between).
  var onPathStopping: () -> Void = {}
  var onPathStarted: () -> Void = {}
  private var observer: NSObjectProtocol?
  private var tapInstalled = false
  private var voiceProcessingOn = false
  // Bug 105: the chosen devices, and whether a unit has been pinned to a device (after which "system
  // default" has to be set explicitly — a pinned unit no longer follows the default by itself).
  private var inputChoice: DeviceChoice
  private var outputChoice: DeviceChoice
  private var pinnedInput = false
  private var pinnedOutput = false
  private var hardwareListeners: [(AudioObjectPropertySelector, AudioObjectPropertyListenerBlock)] = []
  private var hardwareCheckPending = false
  private var stopped = false
  // Bug 196: the input hardware's format at the last tap, the tap-retry backoff, and the
  // configuration-change debounce.
  private var lastHardware: TapFormatInfo?
  /// True while a tap retry is pending: the pipeline's stall watchdog waits for it (bug 196).
  private(set) var recovering = false
  private var tapRetryAttempt = 0
  private var tapRetryGen = 0
  private var configChangePending = false
  init(voiceProcessing: Bool, playback: Bool, input: String?, output: String?, spatial: Bool = false, spatialRoute: String? = nil) {
    self.voiceProcessing = voiceProcessing
    self.playback = playback
    // Bug 213 (review): a 1:1 call is exactly as before — mono, no stereo leg, no seats, no mic swap.
    self.spatialWanted = playback && spatial
    self.spatialRoute = spatialRoute
    inputChoice = DeviceChoice(kind: .input, preferred: input)
    outputChoice = DeviceChoice(kind: .output, preferred: playback ? output : nil)
  }
  private var choices: [DeviceChoice] { playback ? [inputChoice, outputChoice] : [inputChoice] }

  func start() throws {
    observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
      q.async { self?.configChanged() }
    }
    installHardwareListeners()
    _ = refreshChoices()
    try configure()
  }

  /// Bug 196: runs on q. A route change posts a burst of configuration changes; one restart follows.
  private func configChanged() {
    log("AVAudioEngineConfigurationChange (engine running=\(engine.isRunning))")
    if configChangePending || stopped { return }
    configChangePending = true
    q.asyncAfter(deadline: .now() + .milliseconds(TapTiming.configChangeDebounceMs)) { [weak self] in
      guard let self else { return }
      self.configChangePending = false
      if !self.stopped { self.onInterrupted("config-change") }
    }
  }

  /// Re-reads the device list into the choices, emitting any fallback / restore. True when the
  /// running audio path has to be rebuilt.
  private func refreshChoices() -> Bool {
    let devs = listDevices()
    var rebuild = false
    for c in choices {
      let r = c.update(devs, defaultName: defaultDevice(c.kind, devs)?.name ?? "")
      if let e = r.event { log("device: \(e)"); emit(e) }
      rebuild = rebuild || r.rebuild
    }
    return rebuild
  }

  /// Builds the audio path for the current choices: voice processing if asked for (echo
  /// cancellation), the chosen devices, playback wiring, then start. Voice processing is dropped —
  /// and the UI told — when it won't take the chosen devices or won't start (bug 103/104).
  private func configure() throws {
    if playback {
      readRoute()
      if spatialWanted { chooseMic() } else { clearMicOverride() }
    }
    if voiceProcessing {
      // Echo cancellation: the Bot's speech plays through this same voice-processing unit, so the
      // microphone signal has it subtracted and barge-in hears the user, not the Bot.
      do {
        try engine.inputNode.setVoiceProcessingEnabled(true)
        if #available(macOS 14.0, *) {
          engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
        voiceProcessingOn = true
        log("voice processing on")
      } catch {
        log("voice processing unavailable: \(error.localizedDescription)")
        reportEchoUnavailable(error.localizedDescription)
      }
      // One voice-processing unit holds both devices and builds its own aggregate from them. If it
      // won't take this pair, run without echo cancellation rather than on the wrong devices.
      // Bug 213: echo cancellation matters more than stereo — a Mac mic it won't pair with the
      // headset goes back to the headset's own mic first.
      if voiceProcessingOn, micOverride != nil, let why = applyDevices() {
        log("voice processing won't pair the Mac's microphone with this headset (\(why)); using the headset's microphone")
        dropMicOverride(reason: "echo-cancellation")
      }
      if voiceProcessingOn, let why = applyDevices() {
        log("voice processing won't use the chosen devices: \(why)")
        dropVoiceProcessing()
        reportEchoUnavailable(why)
        if let why2 = applyDevices() { log("device selection failed: \(why2)") }
      }
    } else if let why = applyDevices() {
      log("device selection failed: \(why)")
    }
    // Bug 213: the headset leaves hands-free once only the Mac's mic is open — read it again, and
    // build for stereo now rather than rebuild when the listener sees it (A40: ~0.3 s later).
    if playback {
      if micOverride != nil { routeInfo = routeDevice.map(outputRoute) }
      predictStereo = micOverride != nil && routeDevice?.transport == "bluetooth" && (routeInfo?.channels ?? 0) < 2
      if predictStereo { log("output route: \(routeDevice?.name ?? "the headset") is on hands-free; building for stereo, which it returns to once its mic is closed") }
    }
    wirePlayback()
    // Bug 213 (review): one ladder of fallbacks, each tried only if the one above fails to start:
    // as built (stereo + echo cancellation) → mono → the headset's own mic → no echo cancellation (bug 103).
    let steps = startLadder(stereo: stereo, voiceProcessing: voiceProcessingOn, micOverride: micOverride != nil)
    let reached = try climbLadder(steps) { step in
      switch step {
      case .asBuilt:
        try startEngine()
      case .mono:
        // Bug 134: this device pair (or the voice-processing unit) won't run a stereo output. The call
        // matters more than the seats: mono, as before, and the app is told.
        engine.stop()
        stereoFailedFor = routeDevice?.uid ?? ""
        predictStereo = false
        emit(["type": "spatial-unavailable", "reason": "stereo output wouldn't start"])
        wirePlayback()
        try startEngine()
      case .headsetMic:
        // The Mac's mic with this headset won't start with echo cancellation: the headset's own mic
        // (mono hands-free) rather than a call without echo cancellation.
        engine.stop()
        dropMicOverride(reason: "echo-cancellation") // on classic Bluetooth: built mono straight away
        if let why = applyDevices() { log("device selection failed: \(why)") }
        wirePlayback()
        try startEngine()
      case .noEchoCancellation:
        // The voice-processing unit refuses to initialise on some device combinations ("client-side
        // input and output formats do not match", -10875; bug 103). Voice mode must still work: drop
        // echo cancellation for this call and start plainly, rather than failing the whole call.
        engine.stop()
        dropVoiceProcessing()
        reportEchoUnavailable("voice processing wouldn't start")
        if let why = applyDevices() { log("device selection failed: \(why)") }
        wirePlayback()
        try startEngine()
      }
    }
    if reached != .asBuilt { log("audio path started at the fallback: \(reached.rawValue)") }
    // The Mac's mic is watched for digital silence (a closed lid it couldn't see, a muted mic).
    setSilenceWatch(micOverride != nil ? nowMs() : nil)
    emitDevices()
    if playback { watchRoute(); emitRoute() }
  }

  private func dropVoiceProcessing() {
    engine.inputNode.removeTap(onBus: 0); tapInstalled = false
    try? engine.inputNode.setVoiceProcessingEnabled(false)
    voiceProcessingOn = false
    engine.reset()
  }

  private func reportEchoUnavailable(_ reason: String) {
    emit(["type": "echo-unavailable", "reason": String(reason.prefix(200))])
  }

  /// Points the I/O units at the chosen devices. With voice processing the one VPIO unit takes the
  /// input device on element 1 and the output device on element 0; without it the input and output
  /// nodes are separate HAL units, each on element 0. Nil on success, else why not.
  private func applyDevices() -> String? {
    let inEl: AudioUnitElement = voiceProcessingOn ? 1 : 0
    if let d = micOverride ?? inputChoice.active {
      if let why = setCurrentDevice(engine.inputNode.audioUnit, d.id, element: inEl) { return "microphone \(d.name): \(why)" }
      pinnedInput = true
      log("input device \(d.name) [\(d.uid)]")
    } else if pinnedInput, let def = defaultDeviceID(.input) {
      if let why = setCurrentDevice(engine.inputNode.audioUnit, def, element: inEl) { return "default microphone: \(why)" }
    }
    guard playback else { return nil }
    if let d = outputChoice.active {
      if let why = setCurrentDevice(engine.outputNode.audioUnit, d.id, element: 0) { return "speaker \(d.name): \(why)" }
      pinnedOutput = true
      log("output device \(d.name) [\(d.uid)]")
    } else if pinnedOutput, let def = defaultDeviceID(.output) {
      if let why = setCurrentDevice(engine.outputNode.audioUnit, def, element: 0) { return "default speaker: \(why)" }
    }
    return nil
  }

  private func emitDevices() {
    let devs = listDevices()
    let input = micOverride ?? inputChoice.active ?? defaultDevice(.input, devs)
    let output = playback ? (outputChoice.active ?? defaultDevice(.output, devs)) : nil
    log("audio path: input=\(input?.name ?? "?") output=\(output?.name ?? "-") echoCancellation=\(voiceProcessingOn)")
    emit(["type": "devices", "input": deviceRef(input), "output": deviceRef(output), "echoCancellation": voiceProcessingOn, "spatial": stereo])
  }

  /// With voice processing on, the VPIO unit requires its client-side input and output formats to
  /// match (-10875 otherwise). The mixer→output leg therefore runs at the voice-processed input's
  /// own sample rate; the player still feeds the mixer at 48 kHz mono, and the mixer converts.
  /// Bug 105: MONO, not the input's channel count. Probed on macOS 27 with non-default devices: the
  /// VP input reports 9 channels, and "9 channels at the input rate" fails -10875 whenever the input
  /// is a USB webcam mic (C920) — with the built-in speakers and with an HDMI display alike — while
  /// mono at the input rate started in every pair tried (default/default, C920/built-in, built-in/
  /// HDMI, C920/HDMI). The Bot's speech is mono anyway.
  /// Bug 134: spatial voices use a STEREO player and mixer→output leg (2 channels at the same rate);
  /// if that won't start, configure() drops back to mono and says so (spatial-unavailable).
  private func wirePlayback() {
    guard playback else { return }
    // Bug 213: stereo whenever the output device is (a mono Bluetooth hands-free output stays mono).
    stereo = spatialWanted && ((routeInfo?.channels ?? 2) >= 2 || predictStereo) && !predictMono && stereoFailedFor != (routeDevice?.uid ?? "")
    let channels: AVAudioChannelCount = stereo ? 2 : 1
    playerFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: channels)!
    if player.engine == nil { engine.attach(player) }
    engine.connect(player, to: engine.mainMixerNode, format: playerFormat)
    if fxPlayer.engine == nil { engine.attach(fxPlayer) }
    engine.connect(fxPlayer, to: engine.mainMixerNode, format: Kokoro.format)
    if stereo { seats.wire(into: engine, mixer: engine.mainMixerNode, output: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!) }
    else { seats.unwire(from: engine) }
    route = stereo ? routeMode(routeInfo, override: spatialRoute) : .centre
    if voiceProcessingOn {
      let inFmt = engine.inputNode.outputFormat(forBus: 0)
      if inFmt.sampleRate > 0, inFmt.channelCount > 0,
         let outFmt = AVAudioFormat(standardFormatWithSampleRate: inFmt.sampleRate, channels: channels) {
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outFmt)
        log("voice processing formats: input \(inFmt) / mixer→output \(outFmt)")
      }
    } else if stereo, let outFmt = AVAudioFormat(standardFormatWithSampleRate: engine.outputNode.outputFormat(forBus: 0).sampleRate > 0 ? engine.outputNode.outputFormat(forBus: 0).sampleRate : 48000, channels: 2) {
      engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outFmt)
    }
    onOutput(playerFormat, stereo ? seats : nil, route)
  }

  // ---- bug 213: the output route (headphones / speakers / mono) and the microphone that keeps it stereo ----
  private func readRoute() {
    let devs = listDevices()
    let out = outputChoice.active ?? defaultDevice(.output, devs)
    if out?.uid != routeDevice?.uid { stereoFailedFor = nil; predictMono = false }
    routeDevice = out
    routeInfo = out.map(outputRoute)
    let latency = out.map { outputLatencyMs($0.id) } ?? 0
    log("output latency \(Int(latency)) ms (\(out?.transport ?? "-"))")
    onOutputLatency(latency, out?.transport ?? "")
  }

  private func chooseMic() {
    let devs = listDevices()
    let chosen = inputChoice.active ?? defaultDevice(.input, devs)
    let declined = micOverrideFor == "declined:" + (routeDevice?.uid ?? "")
    // Bug 213 (review): a microphone the user chose is never swapped; nor is the Mac's picked with its lid shut.
    var pick = declined ? nil : micKeepingStereo(input: chosen, output: routeDevice, outputChannels: routeInfo?.channels ?? 0, devices: devs,
                                                 userChose: inputChoice.preferred != nil, lidClosed: lidClosed())
    // Kept while the same headset is the output and its mic is still the one asked for.
    if pick == nil, !declined, inputChoice.preferred == nil, !lidClosed(), let o = micOverride, micOverrideFor == routeDevice?.uid,
       chosen?.transport.hasPrefix("bluetooth") == true, devs.contains(where: { $0.id == o.id }) { pick = o }
    guard pick?.id != micOverride?.id else { return }
    micOverride = pick
    micOverrideFor = pick == nil ? nil : routeDevice?.uid
    if pick != nil { predictMono = false }
    if let pick {
      log("microphone: \(pick.name) instead of \(chosen?.name ?? "?"), so \(routeDevice?.name ?? "the headset") stays in stereo")
      emit(["type": "mic-choice", "input": deviceRef(pick), "instead": deviceRef(chosen), "reason": "keep-stereo"])
    } else {
      emit(["type": "mic-choice", "input": NSNull(), "instead": NSNull(), "reason": "none"])
    }
  }

  /// Back to the headset's own mic, and not tried again for this headset in this call (echo
  /// cancellation, or a Mac mic that turned out silent, comes first).
  private func dropMicOverride(reason: String) {
    guard micOverride != nil else { return }
    micOverride = nil
    setSilenceWatch(nil)
    micOverrideFor = "declined:" + (routeDevice?.uid ?? "")
    predictMono = routeDevice?.transport == "bluetooth"
    predictStereo = false
    emit(["type": "mic-choice", "input": NSNull(), "instead": NSNull(), "reason": reason])
  }

  /// A 1:1 call (or spatial voices turned off): the usual microphone, whatever was picked before.
  private func clearMicOverride() {
    guard micOverride != nil else { return }
    micOverride = nil
    micOverrideFor = nil
    setSilenceWatch(nil)
    emit(["type": "mic-choice", "input": NSNull(), "instead": NSNull(), "reason": "none"])
  }

  /// Runs on q, per tap buffer while the Mac's mic is on watch.
  private func noteMicLevel(_ peak: Float) {
    guard let since = silenceWatchSince, micOverride != nil, !stopped else { return }
    silenceWatchPeak = max(silenceWatchPeak, peak)
    switch silentMicVerdict(sinceMs: nowMs() - since, peak: silenceWatchPeak, headsetMicAvailable: silenceWatchHeadset) {
    case .wait: return
    case .fine: setSilenceWatch(nil)
    case .fallBack:
      log("the Mac's microphone gave digital silence for \(Int(nowMs() - since)) ms (lid closed or muted?); back to the headset's microphone")
      dropMicOverride(reason: "mac-mic-silent")
      do { try reconfigure("the Mac's microphone is silent") } catch {
        log("rebuild failed: \(error.localizedDescription)")
        onInterrupted("device-change")
      }
    }
  }

  private func emitRoute() {
    let r = routeInfo
    log("output route: \(routeDevice?.name ?? "?") \(r?.transport ?? "?") \(r?.channels ?? 0) ch\(r?.dataSource.map { " source \(String(format: "%08x", $0))" } ?? "") → voices \(route.rawValue)\(stereo ? "" : " (mono output)")")
    emit(["type": "route", "mode": route.rawValue, "stereo": stereo, "output": deviceRef(routeDevice), "transport": r?.transport ?? "unknown", "channels": r?.channels ?? 0])
  }

  /// The output device's data source (the jack: headphones in or out) and stream layout (Bluetooth
  /// stereo ↔ hands-free) are watched while the call runs.
  private func watchRoute() {
    unwatchRoute()
    guard let d = routeDevice else { return }
    for sel in [kAudioDevicePropertyDataSource, kAudioDevicePropertyStreamConfiguration] {
      var addr = caAddr(sel, kAudioObjectPropertyScopeOutput)
      let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.routeMaybeChanged() }
      if AudioObjectAddPropertyListenerBlock(d.id, &addr, q, block) == noErr { routeListeners.append((d.id, addr, block)) }
    }
  }

  private func unwatchRoute() {
    for (id, addr, block) in routeListeners { var a = addr; AudioObjectRemovePropertyListenerBlock(id, &a, q, block) }
    routeListeners = []
  }

  /// Runs on q. A burst of notifications (a Bluetooth profile switch posts several) → one check.
  private func routeMaybeChanged() {
    if routeCheckPending || stopped || !playback { return }
    routeCheckPending = true
    q.asyncAfter(deadline: .now() + .milliseconds(300)) { [weak self] in
      guard let self else { return }
      self.routeCheckPending = false
      if !self.stopped { self.checkRoute() }
    }
  }

  /// Mid-call: headphones plugged in or out, a headset switching profile, a new default output. The
  /// placement follows at once; the path is rebuilt only when it must be (mono ↔ stereo, another device,
  /// another microphone) — and a rebuild replays whatever hadn't played yet (bug 141).
  private func checkRoute() {
    let before = (device: routeDevice?.uid, id: routeDevice?.id, info: routeInfo, mic: micOverride?.id, stereo: stereo)
    readRoute()
    if spatialWanted { chooseMic() }
    if (routeInfo?.channels ?? 0) >= 2 { predictStereo = false }
    let wantStereo = spatialWanted && ((routeInfo?.channels ?? 2) >= 2 || predictStereo) && !predictMono && stereoFailedFor != (routeDevice?.uid ?? "")
    if routeDevice?.uid != before.device || wantStereo != before.stereo || micOverride?.id != before.mic {
      do { try reconfigure("output route changed") } catch {
        log("rebuild after a route change failed: \(error.localizedDescription)")
        onInterrupted("device-change")
      }
      return
    }
    // The same device under a new id (a Bluetooth profile switch can re-create it): listen to the new one.
    if routeDevice?.id != before.id { watchRoute() }
    guard routeInfo != before.info else { return }
    let m = stereo ? routeMode(routeInfo, override: spatialRoute) : .centre
    if m != route {
      route = m
      onOutput(playerFormat, stereo ? seats : nil, route)
    }
    watchRoute()
    emitRoute()
  }

  private func startEngine() throws {
    // A fresh start supersedes any tap retry still waiting.
    tapRetryGen += 1
    let input = engine.inputNode
    // Bug 196: ALWAYS remove first — the flag can miss a tap, and a second tap on bus 0 aborts.
    input.removeTap(onBus: 0); tapInstalled = false
    // Formats are read fresh, at install time: after a route change the node's output format can
    // still carry the old device's rate, and a tap that doesn't match the hardware is an uncatchable
    // exception. A device mid-switch (no channels / no rate) gets a backoff retry, not an install.
    let hwFmt = input.inputFormat(forBus: 0), nodeFmt = input.outputFormat(forBus: 0)
    let hw = TapFormatInfo(hwFmt)
    let plan = planTap(hardware: hw, node: TapFormatInfo(nodeFmt), strictRate: !voiceProcessingOn)
    log("input format \(nodeFmt) (hardware \(hwFmt)) → \(plan)")
    let fmt: AVAudioFormat
    switch plan {
    case .retry: scheduleTapRetry(); return
    case .node: fmt = nodeFmt
    case .hardware: fmt = hwFmt
    }
    installTapSafely(input, format: fmt, bufferSize: 4096) { [weak self] buf, _ in
      guard let self else { return }
      self.watchLock.lock(); let watching = self.watchingMic; self.watchLock.unlock()
      if watching, let ch = buf.floatChannelData {
        var pk: Float = 0
        for i in 0..<Int(buf.frameLength) { pk = max(pk, abs(ch[0][i])) }
        q.async { self.noteMicLevel(pk) }
      }
      self.onBuffer(buf)
    }
    tapInstalled = true
    lastHardware = hw
    tapRetryAttempt = 0
    recovering = false
    engine.prepare()
    try engine.start()
    if playback { player.play(); fxPlayer.play(); seats.playAll() }
    log("engine started, running=\(engine.isRunning)")
    if playback { onPathStarted() }
  }

  /// Bug 196: the input had no usable format; try again with backoff (on q), then hand over to the
  /// pipeline, which ends it in a clean "no-audio" error — never an abort. While a retry is pending
  /// `recovering` holds the stall watchdog off, so an outer restart can't supersede the backoff.
  private func scheduleTapRetry() {
    if stopped { recovering = false; return }
    guard let ms = tapRetryDelayMs(tapRetryAttempt) else {
      log("the microphone still has no usable format after \(tapRetryAttempt) tries")
      tapRetryAttempt = 0
      recovering = false
      onInterrupted("input-not-ready")
      return
    }
    recovering = true
    tapRetryAttempt += 1
    let gen = tapRetryGen
    log("input not ready (device switching?); retry \(tapRetryAttempt) in \(ms) ms")
    q.asyncAfter(deadline: .now() + .milliseconds(ms)) { [weak self] in
      guard let self, !self.stopped, gen == self.tapRetryGen else { return }
      do {
        try self.startEngine()
        if self.tapInstalled { self.onReconfigured() }
      } catch {
        log("retry failed: \(error.localizedDescription)")
        self.onInterrupted("restart-failed")
      }
    }
  }

  /// Tears the audio path down and builds it again for the current choices (a device came or went,
  /// or the user chose another one). The session — recognizer, call, transcript — carries on.
  private func reconfigure(_ why: String) throws {
    log("rebuilding the audio path (\(why))")
    onPathStopping()
    engine.stop()
    engine.inputNode.removeTap(onBus: 0); tapInstalled = false
    if voiceProcessingOn { try? engine.inputNode.setVoiceProcessingEnabled(false); voiceProcessingOn = false }
    engine.reset()
    try configure()
    onReconfigured()
  }

  func restart() throws {
    // A configuration change is often a device coming or going: re-check the choices first.
    if refreshChoices() { try reconfigure("devices changed"); return }
    // Bug 196: the input hardware's format moved since the last tap (a route change): stop, reset
    // and rebuild the whole path, rather than restart a graph that still has the old formats. (Not
    // with voice processing: its unit posts a configuration change at every call start and its
    // formats are its own — the bug-141 restart path there is unchanged.)
    let hwNow = TapFormatInfo(engine.inputNode.inputFormat(forBus: 0))
    if !voiceProcessingOn, let last = lastHardware, inputRouteChanged(last: last, now: hwNow) {
      try reconfigure("input format changed: \(Int(last.rate)) Hz/\(last.channels) ch → \(Int(hwNow.rate)) Hz/\(hwNow.channels) ch")
      return
    }
    onPathStopping()
    engine.stop()
    engine.inputNode.removeTap(onBus: 0); tapInstalled = false
    do { try startEngine() } catch { try reconfigure("restart failed: \(error.localizedDescription)") }
    // Bug 213: a configuration change is often the output moving (a new default device).
    if playback { routeMaybeChanged() }
  }

  /// Bug 134: stereo seats on or off, keeping the call. Bug 213: a call is stereo from its start, so
  /// the app no longer sends this when a second Bot joins; "on" is then already the case.
  func setSpatial(_ on: Bool) throws {
    guard playback, on != spatialWanted else { return }
    spatialWanted = on
    try reconfigure(on ? "spatial voices on" : "spatial voices off")
  }

  func playFx(_ buf: AVAudioPCMBuffer) {
    guard playback, engine.isRunning, fxPlayer.engine != nil else { return }
    fxPlayer.scheduleBuffer(buf, completionHandler: nil)
    if !fxPlayer.isPlaying { fxPlayer.play() }
  }

  func switchDevices(input: String?, output: String?) throws {
    inputChoice = DeviceChoice(kind: .input, preferred: input)
    outputChoice = DeviceChoice(kind: .output, preferred: playback ? output : nil)
    _ = refreshChoices()
    do {
      try reconfigure("device choice changed")
    } catch {
      // The new pair won't start at all: the system defaults, so the session still has a microphone.
      log("the chosen devices failed (\(error.localizedDescription)); using the system defaults")
      inputChoice = DeviceChoice(kind: .input, preferred: nil)
      outputChoice = DeviceChoice(kind: .output, preferred: nil)
      try reconfigure("falling back to the system defaults")
    }
  }

  // ---- device-change listener: a device plugged in or out, or a new system default ----
  private func installHardwareListeners() {
    let sys = AudioObjectID(kAudioObjectSystemObject)
    for sel in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice] {
      var addr = caAddr(sel)
      let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.hardwareChanged() }
      if AudioObjectAddPropertyListenerBlock(sys, &addr, q, block) == noErr { hardwareListeners.append((sel, block)) }
    }
  }

  /// Runs on q. Coalesces a burst of notifications (one unplug posts several) into one check.
  private func hardwareChanged() {
    if hardwareCheckPending || stopped { return }
    hardwareCheckPending = true
    q.asyncAfter(deadline: .now() + .milliseconds(300)) { [weak self] in
      guard let self else { return }
      self.hardwareCheckPending = false
      if self.stopped { return }
      var rebuild = self.refreshChoices()
      // A unit pinned to "the default" doesn't follow a new default by itself.
      if (self.pinnedInput && self.inputChoice.active == nil) || (self.playback && self.pinnedOutput && self.outputChoice.active == nil) { rebuild = true }
      guard rebuild else { if self.playback { self.checkRoute() }; return }
      do { try self.reconfigure("devices changed") } catch {
        log("rebuild after a device change failed: \(error.localizedDescription)")
        self.onInterrupted("device-change")
      }
    }
  }

  func stop() {
    stopped = true
    if let o = observer { NotificationCenter.default.removeObserver(o); observer = nil }
    let sys = AudioObjectID(kAudioObjectSystemObject)
    for (sel, block) in hardwareListeners {
      var addr = caAddr(sel)
      AudioObjectRemovePropertyListenerBlock(sys, &addr, q, block)
    }
    hardwareListeners = []
    unwatchRoute()
    tapRetryGen += 1
    recovering = false
    engine.stop()
    engine.inputNode.removeTap(onBus: 0); tapInstalled = false
  }
}

/// Self-test source: an audio file played into the pipeline at real-time pace in 100 ms buffers,
/// followed by silence like a quiet room. `--simulate` reproduces the microphone's failure modes:
/// `config-change` (the engine stops itself and reports a configuration change — bug 101),
/// `stall` (buffers just stop coming), `dead` (no audio ever arrives).
final class FileSource: AudioSource {
  let name = "file"
  let file: AVAudioFile
  let simulate: String?
  var onBuffer: (AVAudioPCMBuffer) -> Void = { _ in }
  var onInterrupted: (String) -> Void = { _ in }
  var onFileDone: () -> Void = {}
  var onReconfigured: () -> Void = {}
  private let srcQ = DispatchQueue(label: "bots-dictation.file")
  private var timer: DispatchSourceTimer?
  private var paused = false
  private var fileDone = false
  private var chunks = 0
  private var simulated = false
  init(path: String, simulate: String?) throws {
    file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    self.simulate = simulate
    log("file \(path) format \(file.processingFormat) frames \(file.length)")
  }
  func start() throws {
    let t = DispatchSource.makeTimerSource(queue: srcQ)
    t.schedule(deadline: .now(), repeating: .milliseconds(100))
    t.setEventHandler { [weak self] in self?.tick() }
    timer = t
    t.resume()
  }
  private func tick() {
    if simulate == "dead" || paused { return }
    chunks += 1
    if !simulated && chunks == 6 && (simulate == "config-change" || simulate == "stall") {
      simulated = true
      paused = true
      log("simulating \(simulate!): the source stops delivering audio")
      if simulate == "config-change" { onInterrupted("config-change") }
      return
    }
    let fmt = file.processingFormat
    let frames = AVAudioFrameCount(fmt.sampleRate / 10)
    guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return }
    if !fileDone {
      do { try file.read(into: buf, frameCount: frames) } catch { buf.frameLength = 0 }
      if buf.frameLength == 0 { fileDone = true; log("file consumed"); onFileDone() }
    }
    if fileDone {
      buf.frameLength = frames
      if let ch = buf.floatChannelData {
        for c in 0..<Int(fmt.channelCount) { memset(ch[c], 0, Int(frames) * MemoryLayout<Float>.size) }
      }
    }
    onBuffer(buf)
  }
  func restart() throws { srcQ.async { self.paused = false } }
  func switchDevices(input: String?, output: String?) throws { log("devices command ignored for a file source (input=\(input ?? "default") output=\(output ?? "default"))") }
  func setSpatial(_ on: Bool) throws { log("spatial \(on ? "on" : "off") (a file source has no output)") }
  func playFx(_ buf: AVAudioPCMBuffer) { log("fx: \(buf.frameLength) frames (a file source has no output)") }
  func stop() { timer?.cancel(); timer = nil }
}

/// Bug 198: 16-bit little-endian mono PCM (base64) → float, at `rate`. Nil for an empty or odd-sized chunk.
func int16Buffer(base64: String, rate: Double) -> AVAudioPCMBuffer? {
  guard let d = Data(base64Encoded: base64), d.count >= 2, d.count % 2 == 0,
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else { return nil }
  let n = d.count / 2
  guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n)), let dst = buf.floatChannelData else { return nil }
  buf.frameLength = AVAudioFrameCount(n)
  d.withUnsafeBytes { raw in
    for i in 0..<n { dst[0][i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768 }
  }
  return buf
}

/// Bug 198: float samples → 16-bit little-endian PCM, base64 (clipped, rounded).
func int16Base64(_ s: UnsafePointer<Float>, count n: Int) -> String {
  var d = Data(count: n * 2)
  d.withUnsafeMutableBytes { raw in
    for i in 0..<n {
      let v = Int16(max(-32768, min(32767, (s[i] * 32767).rounded())))
      raw.storeBytes(of: v.littleEndian, toByteOffset: i * 2, as: Int16.self)
    }
  }
  return d.base64EncodedString()
}

/// Bug 198: a call placed from the user's phone. Nothing on this Mac listens or plays: the phone's
/// microphone arrives as `mic <base64 16-bit 16 kHz mono>` lines on stdin (the app relays them from the
/// phone's socket), and the call's output — the Bot's voice, the pauses, the join / leave chime — is
/// rendered by an OFFLINE engine on the pipeline queue at wall-clock pace and written to stdout as
/// `{"type":"out","data":<base64 16-bit 24 kHz mono>}` lines, which the app sends to the phone. The
/// Speaker, its FIFO, fades and barge-in are the same as a Mac call's; only the device is gone. Echo
/// is the phone browser's job (getUserMedia's echoCancellation), so there is no voice processing here.
final class RemoteSource: AudioSource {
  let name = "remote"
  static let outRate = 24000.0
  static let inRate = 16000.0
  let engine = AVAudioEngine()
  let player = AVAudioPlayerNode()
  let fxPlayer = AVAudioPlayerNode()
  /// The same 48 kHz mono the Mac's player takes, so the Speaker's converter is unchanged.
  let playerFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
  let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: RemoteSource.outRate, channels: 1, interleaved: false)!
  var onBuffer: (AVAudioPCMBuffer) -> Void = { _ in }
  var onInterrupted: (String) -> Void = { _ in }
  var onReconfigured: () -> Void = {}
  var onPathStarted: () -> Void = {}
  private var timer: DispatchSourceTimer?
  private var startedAt = 0.0
  private var rendered: Int64 = 0
  private var buf: AVAudioPCMBuffer?
  /// Output goes out while something was audible in the last second (a reply's pauses included), then stops.
  private var lastLoudAt = -10_000.0
  private var chunksOut = 0
  private var stopped = false

  func start() throws {
    engine.attach(player)
    engine.attach(fxPlayer)
    try engine.enableManualRenderingMode(.offline, format: outFormat, maximumFrameCount: 4096)
    engine.connect(player, to: engine.mainMixerNode, format: playerFormat)
    engine.connect(fxPlayer, to: engine.mainMixerNode, format: Kokoro.format)
    engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outFormat)
    buf = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096)
    engine.prepare()
    try engine.start()
    player.play()
    fxPlayer.play()
    startedAt = nowMs()
    // On the pipeline queue: every schedule, stop and fade of the Speaker happens there too, so the
    // offline render never runs under them.
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now(), repeating: .milliseconds(20))
    t.setEventHandler { [weak self] in self?.render() }
    timer = t
    t.resume()
    log("remote audio: output \(Int(RemoteSource.outRate)) Hz mono, input \(Int(RemoteSource.inRate)) Hz mono")
    onPathStarted()
  }

  /// Render what wall-clock time says has played since the start, and send it.
  private func render() {
    guard !stopped, let buf else { return }
    let now = nowMs()
    let due = Int64((now - startedAt) / 1000 * RemoteSource.outRate)
    var left = due - rendered
    // Asleep or stalled for a long time: skip ahead rather than send a burst of stale audio.
    if left > Int64(RemoteSource.outRate) { rendered = due - 480; left = 480 }
    while left > 0 {
      let n = AVAudioFrameCount(min(left, 4096))
      do {
        let status = try engine.renderOffline(n, to: buf)
        guard status == .success else { log("remote audio: render status \(status.rawValue)"); return }
      } catch {
        log("remote audio: render failed: \(error.localizedDescription)")
        return
      }
      rendered += Int64(buf.frameLength)
      left -= Int64(buf.frameLength)
      guard buf.frameLength > 0, let s = buf.floatChannelData?[0] else { return }
      let count = Int(buf.frameLength)
      var peak: Float = 0
      for i in 0..<count { peak = max(peak, abs(s[i])) }
      if peak > 1e-4 { lastLoudAt = now }
      if now - lastLoudAt > 1000 { continue }
      chunksOut += 1
      let line = "{\"type\":\"out\",\"data\":\"\(int16Base64(s, count: count))\"}"
      outLock.lock(); print(line); fflush(stdout); outLock.unlock()
    }
  }

  /// One chunk of the phone's microphone.
  func feed(base64: String) {
    guard !stopped else { return }
    guard let b = int16Buffer(base64: base64, rate: RemoteSource.inRate) else { log("remote audio: bad mic chunk"); return }
    onBuffer(b)
  }

  /// The phone stopped sending for a moment (the watchdog's restart): nothing to rebuild here.
  func restart() throws { onPathStarted() }
  func switchDevices(input: String?, output: String?) throws { log("devices command ignored for a phone call") }
  func setSpatial(_ on: Bool) throws {
    guard on else { return }
    log("spatial voices stay mono on a phone call")
    emit(["type": "spatial-unavailable", "reason": "phone"])
  }
  func playFx(_ b: AVAudioPCMBuffer) {
    fxPlayer.scheduleBuffer(b, completionHandler: nil)
    if !fxPlayer.isPlaying { fxPlayer.play() }
  }
  func stop() {
    stopped = true
    timer?.cancel()
    timer = nil
    engine.stop()
    log("remote audio: \(chunksOut) output chunks sent")
  }
}

// ---------- bug 106: voice choice, end of turn, barge-in (pure logic, self-tested) ----------
/// One installed voice, as the ranking sees it. quality: 1 default (compact), 2 enhanced, 3 premium.
struct VoiceInfo {
  let id: String; let name: String; let lang: String; let quality: Int; let novelty: Bool; let personal: Bool
  var siri: Bool { id.contains(".siri.") }
  /// The Eloquence voices (Eddy, Flo, …) are "default" quality and sound robotic; last resort only.
  var eloquence: Bool { id.contains(".eloquence.") }
  var qualityName: String { quality >= 3 ? "premium" : quality == 2 ? "enhanced" : "default" }
  var json: [String: Any] { ["id": id, "name": name, "lang": lang, "quality": qualityName, "siri": siri, "personal": personal] }
}

func normLocale(_ l: String) -> String { l.replacingOccurrences(of: "_", with: "-") }

/// Premium beats enhanced beats compact, always; then the exact locale, then a few known-good names.
func voiceScore(_ v: VoiceInfo, locale: String) -> Int {
  var s = v.quality * 100
  if v.eloquence { s -= 60 }
  if v.id.contains("super-compact") { s -= 10 }
  if normLocale(v.lang) == normLocale(locale) { s += 30 }
  let liked = ["Ava", "Zoe", "Evan", "Samantha", "Allison", "Tom", "Nathan", "Daniel", "Karen"]
  if let i = liked.firstIndex(where: { v.name.hasPrefix($0) }) { s += 20 - i }
  return s
}

/// The voices a person can pick for `locale`'s language, best first. Novelty voices never; personal
/// voices only when the user has authorized this app to use them.
func rankVoices(_ all: [VoiceInfo], locale: String, personalAllowed: Bool) -> [VoiceInfo] {
  let base = String(normLocale(locale).prefix(while: { $0 != "-" }))
  return all.filter { !$0.novelty && (personalAllowed || !$0.personal) && String(normLocale($0.lang).prefix(while: { $0 != "-" })) == base }
    .enumerated().sorted { a, b in
      let sa = voiceScore(a.element, locale: locale), sb = voiceScore(b.element, locale: locale)
      return sa != sb ? sa > sb : a.offset < b.offset
    }.map { $0.element }
}

/// The voice for a reply. `requested` is an identifier (Settings → Voice) or a name (the per-Bot
/// voice, which names several installed voices: "Samantha" is compact AND enhanced), which means that
/// name's best-quality voice. Nothing requested (or not installed) → the best voice for the locale;
/// never a personal voice unless it was asked for by identifier and is authorized.
func chooseVoice(_ all: [VoiceInfo], requested: String?, locale: String, personalAllowed: Bool) -> VoiceInfo? {
  if let r = requested, !r.isEmpty {
    if let v = all.first(where: { $0.id == r }), personalAllowed || !v.personal { return v }
    let named = all.filter { $0.name == r && !$0.novelty && (personalAllowed || !$0.personal) }
    if let v = named.max(by: { voiceScore($0, locale: locale) < voiceScore($1, locale: locale) }) { return v }
  }
  return rankVoices(all, locale: locale, personalAllowed: false).first
}

/// End of turn: a short silence after a finished sentence, a longer one after a trailing "and" / "so"
/// / "um" (the user is mid-thought), and the recognizer's own end-of-segment when it gives one.
/// Punctuation comes from the recognizer (addsPunctuation), which reads a question's rising intonation.
struct EndOfTurn: Equatable { let done: Bool; let reason: String; let windowMs: Double }
/// Plan item 2: the voice pause a "no new words" end needs, and how long wordless voice runs before it ends anyway.
enum NoNewWords { static let pauseMs = 300.0; static let noiseMs = 5_000.0 }
/// A static, not a global: top-level globals initialize in file order, after the mode dispatch above runs.
enum HoldWords { static let all: Set<String> = ["and", "so", "um", "uh", "umm", "uhm", "er", "erm", "but", "or", "because", "cause", "like", "then", "the", "a", "an", "to", "of", "with", "if", "that", "which", "my", "your", "is", "was", "for", "in", "on", "at", "about", "well", "also", "plus", "maybe"] }
/// Plan item 16 (call-behaviour): the Bot just asked something (the app's `expect-answer`), and this is a short closed
/// answer — "Yes." "No thanks." "Tuesday." — one or two words from a closed set, not trailing. It ends at
/// ShortAnswer.eotMs instead of waiting out the 560 / 700 ms window (20% of the user's turns were 1-2 words).
enum ShortAnswer {
  static let eotMs = 400.0
  /// An expect-answer the user never took up (they said nothing for this long) lapses.
  static let expireMs = 15_000.0
  static let words: Set<String> = ["yes", "yeah", "yep", "yup", "no", "nope", "nah", "sure", "okay", "ok", "fine", "please", "thanks",
    "correct", "right", "exactly", "definitely", "absolutely", "perfect", "great", "good", "cool", "both", "neither", "either", "later",
    "now", "today", "tonight", "tomorrow", "morning", "afternoon", "evening", "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday", "weekend", "first", "second", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "not", "yet", "go", "ahead", "do", "it", "sounds", "works", "true", "false", "maybe", "never", "always"]
}
func isShortAnswer(_ text: String) -> Bool {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if t.isEmpty || t.hasSuffix(",") || t.hasSuffix("-") || t.hasSuffix("…") || t.hasSuffix("...") { return false }
  let words = t.lowercased().split(whereSeparator: { $0 == " " }).map { $0.trimmingCharacters(in: .punctuationCharacters) }.filter { !$0.isEmpty }
  guard (1...2).contains(words.count), let last = words.last, !HoldWords.all.contains(last) || last == "it" else { return false }
  return words.allSatisfy { ShortAnswer.words.contains($0) || Int($0) != nil }
}
func endOfTurn(text: String, silenceMs: Double, sinceWordsMs: Double, baseMs: Double, segmentEnded: Bool, shortAnswer: Bool = false) -> EndOfTurn {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  let last = t.split(whereSeparator: { $0 == " " }).last.map { String($0).lowercased().trimmingCharacters(in: .punctuationCharacters) } ?? ""
  let trailing = t.hasSuffix(",") || t.hasSuffix("-") || t.hasSuffix("…") || t.hasSuffix("...") || HoldWords.all.contains(last)
  let finished = !trailing && (t.hasSuffix(".") || t.hasSuffix("?") || t.hasSuffix("!"))
  let (window, reason): (Double, String) =
    shortAnswer && isShortAnswer(t) ? (min(baseMs, ShortAnswer.eotMs), "short-answer")
    : trailing ? (max(baseMs * 2.5, 1800), "hold-trailing")
    : segmentEnded ? (min(baseMs, 400), "recognizer-final")
    : finished ? (baseMs * 0.8, "punctuation")
    : (baseMs, "silence")
  if silenceMs >= window { return EndOfTurn(done: true, reason: reason, windowMs: window) }
  // Noise that keeps the voice detector busy without new words must still end the turn.
  // Plan item 2 (call-behaviour): but not while the voice is still going — Apple's words stall for a second or two
  // while the user talks on (42 of 57 "no new words" ends on the user's calls came with under 200 ms of silence, and
  // 26 of those users went on within 1.5 s). The voice must have paused (300 ms, or the window if shorter); only 5 s
  // of voice with no words at all (a fan, the room) ends it regardless.
  let cap = max(window * 1.5, baseMs * 2.5)
  let voicePaused = silenceMs >= min(window, NoNewWords.pauseMs)
  if sinceWordsMs >= cap && (voicePaused || sinceWordsMs >= NoNewWords.noiseMs) { return EndOfTurn(done: true, reason: "no-new-words", windowMs: cap) }
  return EndOfTurn(done: false, reason: reason, windowMs: window)
}

/// Bug 189: the silence the LIKELY end is judged on. Silence was counted from the LATER of the voice's last
/// frame and the recognizer's last partial — and Apple's partials trail the words by 300-500 ms (the one
/// that only adds the closing "?" later still), so the "150 ms" likely end came 0.5-0.6 s after the voice
/// stopped. Now it is the voice's own silence once the words have settled (no new partial for
/// `settleMs`); while they are still changing, only as long as they have been still.
/// The END of turn deliberately keeps the old clock: judged on the voice, the same 700 / 560 ms windows
/// ended the turn inside 11 of 20 mid-thought pauses instead of 6 (test-reports/voice-call-feel) — the
/// likely end starts the reply early instead, and nothing plays before the end of turn confirms it.
func turnSilence(voiceSilenceMs: Double, sinceWordsMs: Double, settleMs: Double) -> Double {
  sinceWordsMs >= settleMs ? voiceSilenceMs : min(voiceSilenceMs, sinceWordsMs)
}
/// 5.8: how many likely ends one utterance may send (the first, then one per stretch of new words after it).
enum LikelyEnds { static let max = 3 }
/// 5.8: whether a likely end may go out: none yet, or new words since the last one (and fewer than LikelyEnds.max).
func likelyAgain(sent: Bool, sentFor: String, count: Int, text: String) -> Bool {
  if !sent { return true }
  return count < LikelyEnds.max && spokenKey(text) != spokenKey(sentFor)
}
/// The words of a transcript without case or punctuation (Apple adds a "?" to the same words later).
func spokenKey(_ s: String) -> String {
  s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == " " }.map(String.init).joined()
    .split(separator: " ").joined(separator: " ")
}
/// Bug 189: how long the recognizer's words must have stood still before the voice's silence counts.
enum WordsSettle { static let likelyMs = 150.0 }

/// Bug 142: words that leave a clause open ("I want to", "could you please", "and") — the speaker is
/// not done, however long the pause. Added to the hold words above.
enum OpenWords { static let all: Set<String> = ["can", "could", "would", "will", "should", "please", "going", "gonna", "wanna", "want", "need", "than", "as", "from", "into", "by", "i", "i'm", "we", "they", "he", "she", "whether", "are", "were", "be", "have", "has", "had", "do", "does", "did", "just", "really", "very"] }

/// Bug 142: how far the voice fell at the end of an utterance (dB): the median level of the voiced frames
/// before the last 400 ms minus the mean of the last 300 ms. Positive = falling (a statement or question
/// winding down); nil = too little voice to tell. `levels`: (ms, dB) of voiced frames, oldest first.
func tailFall(_ levels: [(Double, Double)]) -> Double? {
  guard levels.count >= 10, let end = levels.last?.0 else { return nil }
  let body = levels.filter { $0.0 < end - 400 }.map { $0.1 }.sorted()
  let tail = levels.filter { $0.0 >= end - 300 }.map { $0.1 }
  guard body.count >= 5, !tail.isEmpty else { return nil }
  return body[body.count / 2] - tail.reduce(0, +) / Double(tail.count)
}

/// Bug 142: a LIKELY end of turn, to start the reply before the silence window runs out (the app cancels
/// the early start if more words come). Needs a complete clause (2+ words, no trailing hold or open
/// word, no comma) that the recognizer closed — sentence punctuation, or its own end of segment —
/// then 150 ms of silence when the voice fell at the end, else 250 ms (punctuation) / 300 ms (segment).
func likelyEnd(text: String, silenceMs: Double, segmentEnded: Bool, tailFallDb: Double?) -> (likely: Bool, windowMs: Double) {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  let words = t.split(whereSeparator: { $0 == " " })
  let last = words.last.map { String($0).lowercased().trimmingCharacters(in: .punctuationCharacters) } ?? ""
  if words.count < 2 || t.hasSuffix(",") || t.hasSuffix("-") || t.hasSuffix("…") || t.hasSuffix("...") { return (false, 0) }
  if HoldWords.all.contains(last) || OpenWords.all.contains(last) { return (false, 0) }
  let punct = t.hasSuffix(".") || t.hasSuffix("?") || t.hasSuffix("!")
  // Bug 189: or a complete clause whose voice FELL at the end — Apple leaves most finished statements
  // unpunctuated until its final, so punctuation alone missed half of them.
  let fell = (tailFallDb ?? 0) >= 3
  guard punct || segmentEnded || fell else { return (false, 0) }
  let window: Double = punct && fell ? 150 : punct ? 250 : 300
  return (silenceMs >= window, window)
}

// ---------- spoken commands and post-correction (bug 162) ----------
// Dictation only. The user says "new line", "period", "scratch that"; the words are acted on here
// and never reach the model. Editing commands ("delete that") act on what was dictated so far, so
// they run over the whole transcript in order, left to right.

/// One spoken editing/punctuation command and the words that say it.
private enum SpokenCommand {
  case text(String)          // replace the phrase with this literal
  case deleteWord            // "delete that" — drop the word before it
  case deleteSentence        // "scratch that" — drop the sentence before it

  /// Longest phrases first, so "new paragraph" wins over "new line" and "question mark" over "mark".
  static let table: [(words: [String], cmd: SpokenCommand)] = [
    (["new", "paragraph"], .text("\n\n")),
    (["new", "line"], .text("\n")),
    (["question", "mark"], .text("?")),
    (["exclamation", "mark"], .text("!")),
    (["exclamation", "point"], .text("!")),
    (["open", "quote"], .text("\u{201C}")),
    (["close", "quote"], .text("\u{201D}")),
    (["scratch", "that"], .deleteSentence),
    (["delete", "that"], .deleteWord),
    (["semi", "colon"], .text(";")),
    (["semicolon"], .text(";")),
    (["period"], .text(".")),
    (["full", "stop"], .text(".")),
    (["comma"], .text(",")),
    (["colon"], .text(":")),
    (["hyphen"], .text("-")),
    (["dash"], .text("\u{2014}")),
    (["ellipsis"], .text("\u{2026}")),
  ].sorted { $0.words.count > $1.words.count }
}

/// The bare word behind a token: lowercased, stripped of the punctuation the recognizer added.
/// "Period." → "period", so a command still matches once addsPunctuation has been at it.
func commandWord(_ token: String) -> String {
  token.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".,!?;:\u{201C}\u{201D}\"'"))
}

/// Rewrite a dictated transcript: spoken punctuation becomes marks, "new line" becomes a break,
/// "delete that" / "scratch that" erase what came before. Returns the text the user meant.
func applySpokenCommands(_ text: String) -> String {
  let tokens = text.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init)
  guard !tokens.isEmpty else { return text }
  // `out` holds finished pieces: a word, or a mark that attaches to the word before it.
  var out: [String] = []
  var i = 0
  while i < tokens.count {
    var matched = false
    for entry in SpokenCommand.table {
      guard i + entry.words.count <= tokens.count else { continue }
      let slice = (0..<entry.words.count).map { commandWord(tokens[i + $0]) }
      guard slice == entry.words else { continue }
      switch entry.cmd {
      case .text(let s):
        if s == "\n" || s == "\n\n" { out.append(s) } else { out.append("\0" + s) } // \0 = attaches left
      case .deleteWord:
        // Drop the last real word (a mark that trails it goes with it).
        while let l = out.last, l.hasPrefix("\0") || l == "\n" || l == "\n\n" { out.removeLast() }
        if !out.isEmpty { out.removeLast() }
      case .deleteSentence:
        // Back up to just after the previous sentence-ending mark or paragraph break.
        while let l = out.last {
          if l == "\n" || l == "\n\n" { out.removeLast(); break }
          if l.hasPrefix("\0"), [".", "!", "?"].contains(String(l.dropFirst())) { break }
          out.removeLast()
        }
      }
      i += entry.words.count
      matched = true
      break
    }
    if !matched { out.append(tokens[i]); i += 1 }
  }
  // Join: a "\0"-marked piece sticks to the word before it; a break eats the space around it.
  var s = ""
  for piece in out {
    if piece.hasPrefix("\0") {
      // A spoken mark replaces whatever mark addsPunctuation already put there: the user said
      // "period", so "hello there," becomes "hello there." and never "hello there,.".
      while let l = s.last, ".,!?;:".contains(l) { s.removeLast() }
      s += String(piece.dropFirst())
    } else if piece == "\n" || piece == "\n\n" {
      s = s.trimmingCharacters(in: .whitespaces) + piece
    } else {
      s += (s.isEmpty || s.hasSuffix("\n") ? "" : " ") + piece
    }
  }
  return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Filler the recognizer transcribed that the user did not mean to say. Only stripped when it stands
/// alone between words — "um" inside "umbrella" or a whole utterance of "um" is left alone.
enum Filler { static let all: Set<String> = ["um", "umm", "uh", "uhh", "uhm", "erm", "ah", "eh"] }

/// Drop standalone filler words. An utterance that is nothing but filler survives untouched, because
/// the call loop treats it as a hold ("um…" = still thinking) and needs to see it.
func stripFiller(_ text: String) -> String {
  let tokens = text.split(whereSeparator: { $0 == " " }).map(String.init)
  let kept = tokens.filter { !Filler.all.contains(commandWord($0)) }
  if kept.isEmpty || kept.count == tokens.count { return text }
  // A filler word often carries the comma the recognizer put after it ("Um, I think") — rejoin cleanly.
  var s = kept.joined(separator: " ")
  s = s.replacingOccurrences(of: " ,", with: ",")
  if let f = s.first, f == "," { s = String(s.dropFirst()).trimmingCharacters(in: .whitespaces) }
  return s.trimmingCharacters(in: .whitespaces)
}

/// How far apart two words sound, after folding the spellings that sound alike (ph→f, c/k/q→k,
/// z→s, doubled letters, a silent trailing e). Mirrors the renderer's call-name matcher.
func soundFold(_ s: String) -> String {
  var t = s.lowercased().folding(options: .diacriticInsensitive, locale: nil)
  t = t.filter { $0.isLetter || $0.isNumber }
  t = t.replacingOccurrences(of: "ph", with: "f")
  t = t.replacingOccurrences(of: "ck", with: "k")
  var o = ""
  for c in t {
    let m: Character = c == "c" || c == "q" ? "k" : c == "z" ? "s" : c == "y" ? "i" : c
    if o.last != m { o.append(m) }
  }
  if o.count > 3 && o.hasSuffix("e") { o.removeLast() }
  return o
}

/// Levenshtein distance, capped: it stops counting once it is past `limit`.
func editDistance(_ a: String, _ b: String, limit: Int) -> Int {
  if abs(a.count - b.count) > limit { return limit + 1 }
  let x = Array(a), y = Array(b)
  var prev = Array(0...y.count)
  var cur = prev
  for i in 1...max(x.count, 1) where !x.isEmpty {
    cur[0] = i
    for j in 1...max(y.count, 1) where !y.isEmpty {
      cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1))
    }
    if cur.min() ?? 0 > limit { return limit + 1 }
    swap(&prev, &cur)
  }
  return prev[y.count]
}

/// Restore a known name the recognizer nearly got ("Kakoro" → "Kokoro", "orb stack" → "OrbStack").
/// Only near misses are corrected, and only where the heard words are not themselves a common word:
/// a wrong correction is worse than a missed one, so the bar is deliberately high.
/// `names` are the session's contextual names, longest first.
func fixNames(_ text: String, names: [String]) -> String {
  guard !names.isEmpty else { return text }
  let byLength = names.filter { !$0.isEmpty }.sorted { $0.split(separator: " ").count > $1.split(separator: " ").count }
  var tokens = text.split(whereSeparator: { $0 == " " }).map(String.init)
  for name in byLength {
    let nameWords = name.split(separator: " ").map(String.init)
    let want = soundFold(name)
    if want.count < 4 { continue } // too short to correct safely
    var i = 0
    while i < tokens.count {
      // Try the name's own word count, and one more / one fewer (the recognizer may split or join).
      // `step` is how far to advance: 1 when nothing matched, the span when something did.
      var step = 1
      for span in [nameWords.count, nameWords.count + 1, max(1, nameWords.count - 1)] {
        guard span > 0, i + span <= tokens.count else { continue }
        let slice = Array(tokens[i..<(i + span)])
        // The trailing punctuation the recognizer added is kept and re-attached.
        let tail = slice.last!.suffix(while: { ".,!?;:".contains($0) })
        let heard = slice.joined(separator: " ")
        let bare = String(heard.dropLast(tail.count))
        let fold = soundFold(bare)
        if bare == name { step = span; break } // already right: move past it, don't look again
        // A short name has too many near neighbours in ordinary English ("Nova"/"note"/"nove"), so
        // it is only restored on an exact sound match; the bar loosens as the name gets longer.
        let limit = fold.count <= 5 ? 0 : fold.count <= 8 ? 1 : 2
        guard editDistance(fold, want, limit: limit) <= limit else { continue }
        tokens.replaceSubrange(i..<(i + span), with: [name + tail])
        step = 1 // the span collapsed to one token
        break
      }
      i += step
    }
  }
  return tokens.joined(separator: " ")
}

/// Numbers and units the recognizer writes out in words where the user means a figure.
/// Conservative: only the shapes that are unambiguous in a chat message.
func fixUnits(_ text: String) -> String {
  var s = text
  let pairs: [(String, String)] = [
    ("gigabytes", "GB"), ("gigabyte", "GB"), ("megabytes", "MB"), ("megabyte", "MB"),
    ("kilobytes", "KB"), ("terabytes", "TB"), ("milliseconds", "ms"), ("millisecond", "ms"),
    ("percent", "%"),
  ]
  for (word, unit) in pairs {
    // "42 gigabytes" → "42 GB"; a bare "gigabytes" with no figure in front is left as words.
    s = s.replacingOccurrences(of: "(\\d+(?:\\.\\d+)?) \(word)\\b", with: "$1 \(unit)",
                               options: [.regularExpression, .caseInsensitive])
  }
  // "point five" between figures: "8 point 5" → "8.5".
  s = s.replacingOccurrences(of: "(\\d) point (\\d)", with: "$1.$2", options: [.regularExpression, .caseInsensitive])
  return s
}

/// The whole cheap fixer over a final transcript. No model call: fold in this order so that a name
/// restored from filler-free text is not confused by an "um" in the middle of it.
func postCorrect(_ text: String, names: [String], commands: Bool) -> String {
  var s = text
  if commands { s = applySpokenCommands(s) }
  s = stripFiller(s)
  s = fixNames(s, names: names)
  s = fixUnits(s)
  return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

extension StringProtocol {
  /// The trailing run of characters passing `p` (used to keep the punctuation on a corrected name).
  func suffix(while p: (Character) -> Bool) -> String {
    var out = ""
    for c in reversed() { if p(c) { out.insert(c, at: out.startIndex) } else { break } }
    return out
  }
}

// Bug 165: whisper.cpp re-transcribes the finished utterance, Apple keeps the live partials.
//
// Apple's `SFSpeechRecognizer` is good at the two things a live microphone needs — a first partial
// in ~900 ms and a reliable end-of-turn — and bug 162 got its word error rate down to 5.2% on the
// synthesised corpus by biasing it with the session's own vocabulary. What it is still weak at is
// the WORDS: it commits early, one utterance at a time, with no look-ahead over the whole sentence.
// whisper.cpp sees the whole utterance at once and can be told the vocabulary in its prompt.
//
// So the two run in series, not in competition: Apple drives the screen and the end of the turn,
// and when the turn ends the captured PCM (16 kHz mono float — exactly what whisper wants, and what
// the pipeline already has) goes to whisper. Whisper's text becomes the final IF it comes back in
// the budget and looks plausible; otherwise Apple's text stands and the reason is logged. Nothing
// the user sees gets slower: the partials stay on screen while whisper runs.
//
// The model is loaded once, on a background queue, at helper start — never on the path from the end
// of a turn to the final. A missing binary, a missing model or a failed load are all just "whisper
// off": dictation behaves exactly as it did before bug 165.
//
// WHISPER is set by build.sh only when the static libraries are present (app/native/whisper/install.sh
// puts them there). Without them this file compiles to the stubs at the bottom and the helper has no
// whisper in it at all — which is what makes "a missing binary never breaks dictation" true by
// construction rather than by a run-time check.

// ---------- pure logic (self-tested by --self-test-text; no model, no audio) ----------

/// How many samples of 16 kHz mono are worth sending to whisper, and how a long turn is fed to it.
/// Below the floor the audio is too short for it to beat Apple (and short clips are where it
/// hallucinates). Bug 185: there is no longer a ceiling of one 30 s window — a turn longer than
/// that is cut into chunks at quiet points and each chunk is transcribed in the background WHILE
/// the user is still talking, so the end of a three-minute speech costs one chunk, not three minutes.
enum WhisperLimit {
  static let minSamples = 8_000       // 0.5 s
  /// Samples not yet handed to whisper are kept up to this (10 min). Chunking normally hands them
  /// over every ~28 s, so this is only reached when the model never finished loading.
  static let maxSamples = 9_600_000
  static let promptChars = 220        // whisper's prompt is 224 tokens; keep well inside it
  /// Bug 185: the previous chunk's closing words, as context for the next one (on top of the names).
  static let contextChars = 160
  static let defaultBudgetMs = 800.0
  /// Bug 185: one chunk is at most 28 s — one 30 s encoder window with room to spare — and is cut
  /// at the quietest 100 ms of its last 5 s, which is the gap between two words.
  static let chunkSamples = 448_000
  static let chunkSearchSamples = 80_000
  /// Bug 185: the budget grows with the audio past the first 5 s (measured, see `whisperBudget`).
  static let budgetFreeSamples = 80_000
  static let budgetPerSecondMs = 60.0
  /// ...and never past this, so a stop is never kept waiting on a wedged encode.
  static let maxBudgetMs = 6_000.0
  /// Chunks transcribed while the user is still talking get this many times the budget.
  static let backgroundBudgetFactor = 2.0
  /// Bug 185: the same word or phrase this many times running is whisper looping, not the user.
  static let loopRun = 4
  /// ...and a single word this many times (people do say "no no no no"; measured loop: 66).
  static let loopRunWord = 6
}

/// The initial prompt: the same vocabulary Apple gets as contextual strings, written as the kind of
/// text that could plausibly precede the utterance, because that is what whisper conditions on.
///
/// Deliberately SHORT. A long prompt costs decode time, and a prompt that runs past whisper's token
/// budget is silently truncated mid-word; worse, a long list of proper nouns makes whisper start
/// producing them when they were not said. Measured both ways — see the bug log.
func whisperPrompt(_ names: [String], limit: Int = WhisperLimit.promptChars) -> String {
  let usable = names.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty && $0.count <= 40 }
  guard !usable.isEmpty else { return "" }
  var picked: [String] = []
  var used = 0
  for n in usable {
    let cost = n.count + (picked.isEmpty ? 0 : 2)
    if used + cost > limit { break }
    picked.append(n)
    used += cost
  }
  guard !picked.isEmpty else { return "" }
  return picked.joined(separator: ", ") + "."
}

/// The encoder always processes a whole 30 s window, so a 4 s utterance pays for 26 s of silence.
/// `audio_ctx` cuts the window down to what the audio actually fills (plus a second of slack).
/// 1500 positions = 30 s.
///
/// The floor of 768 is measured, not guessed, and it is a floor for a reason: below it whisper stops
/// producing a transcript and starts producing the same sentence over and over — a 3.7 s line came
/// back THIRTEEN times at 256, even with `single_segment` on. 768 is both faster and more accurate
/// than the full window on the corpus (464 ms against 1023 ms, and the full window was the one that
/// ran "Disk Saver" together into "DiskSaver"), so nothing is traded away by capping it there.
func whisperAudioCtx(samples: Int) -> Int32 {
  let seconds = Double(samples) / 16_000.0 + 1.0
  let raw = Int((seconds / 30.0 * 1500.0).rounded(.up))
  let rounded = ((raw + 63) / 64) * 64
  return Int32(min(1500, max(768, rounded)))
}

// ---------- bug 185: long speech ----------

/// How long whisper may take on `samples` of audio. The base (the app passes 900 ms) was measured on
/// 4 s clips and still holds for anything up to 5 s, so short turns are exactly as fast as before;
/// past that it grows by `budgetPerSecondMs` per second of audio — twice whisper's measured cost per
/// second on this Mac, so a slower one still fits — and stops at `maxBudgetMs`. Before bug 185 a
/// 26 s turn aborted at 900 ms every time and the user got Apple's text.
func whisperBudget(baseMs: Double, samples: Int) -> Double {
  let extra = Double(max(0, samples - WhisperLimit.budgetFreeSamples)) / 16_000.0 * WhisperLimit.budgetPerSecondMs
  return min(WhisperLimit.maxBudgetMs, max(baseMs, baseMs + extra))
}

/// Where to end a chunk that starts at `from`: the middle of the quietest 100 ms in the last
/// `search` samples before `from + maxLen`. Speech has a gap between words every fraction of a
/// second, so the cut lands in one and no word is split across two chunks — which is what lets the
/// chunks be joined without an overlap to reconcile. Never past `from + maxLen` (one window).
func whisperCut(_ pcm: [Float], from: Int, maxLen: Int, search: Int) -> Int {
  let end = min(pcm.count, from + maxLen)
  let start = max(from + 1, end - search)
  let frame = 320, span = 5 // 20 ms frames, 100 ms windows
  guard end - start >= frame * span else { return end }
  var energies: [Float] = []
  var i = start
  while i + frame <= end {
    var e: Float = 0
    for k in i..<(i + frame) { e += pcm[k] * pcm[k] }
    energies.append(e)
    i += frame
  }
  var best = 0, bestSum = Float.greatestFiniteMagnitude
  var run: Float = energies.prefix(span).reduce(0, +)
  for j in 0...(energies.count - span) {
    if j > 0 { run += energies[j + span - 1] - energies[j - 1] }
    if run <= bestSum { bestSum = run; best = j } // <=: the LATEST quietest window keeps chunks long
  }
  return start + (best * frame) + (span * frame) / 2
}

/// Join whisper's chunks back into one transcript. A chunk that is only whisper's silence filler
/// adds nothing (it was a pause), and where a chunk opens with the words the previous one closed on
/// — whisper sometimes re-reads its context prompt — they are said once. Two words at least, so a
/// genuinely repeated word ("no, no") is never taken for a seam. Known and accepted: a phrase of
/// two or more words the user really did say twice, exactly across a cut ("…the shop. | The shop
/// was…"), is said once; cuts land in the quietest gap of a 5 s window, so this needs the repeat to
/// straddle that one gap.
func stitchWhisper(_ parts: [String]) -> String {
  var out: [String] = []
  for raw in parts {
    let part = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if part.isEmpty || WhisperNoise.isNoise(part) { continue }
    var tokens = part.split(separator: " ").map(String.init)
    // As far back as the context prompt reaches (160 characters, ~30 words): what whisper re-reads
    // is the prompt, and it has been measured re-reading a whole 11-word sentence of it.
    let tail = out.suffix(40).map { WhisperNoise.fold($0) }
    let head = tokens.prefix(40).map { WhisperNoise.fold($0) }
    var drop = 0
    if tail.count >= 2 && head.count >= 2 {
      for k in stride(from: min(tail.count, head.count), through: 2, by: -1) where Array(tail.suffix(k)) == Array(head.prefix(k)) {
        drop = k
        break
      }
    }
    tokens.removeFirst(drop)
    out.append(contentsOf: tokens)
  }
  return out.joined(separator: " ")
}

/// Apple's on-device recognizer STARTS ITS TEXT OVER after a pause: one result reads "…ready by
/// then." and the next reads "After" (measured, bug 185), and everything before the pause was gone
/// from the utterance — the final had lost the first 35 words of a 110-word dictation. So each new
/// result is either a revision of the current stretch (it grows or is corrected in place) or the
/// start of a new stretch, in which case the old one is committed. A restart shrinks the text by
/// more than half AND either changes its first word or follows a finished sentence; a revision does
/// neither. Returns the committed text and what the utterance now says in full.
func mergeAppleResult(committed: String, previous: String, next: String) -> (committed: String, text: String) {
  let join = { (a: String, b: String) -> String in a.isEmpty ? b : b.isEmpty ? a : a + " " + b }
  // An empty or whitespace-only result says nothing new: the utterance still says what it said.
  // (Without this the restart rule below saw no words and returned just `committed`, dropping the
  // whole current stretch.) The caller keeps `previous` as its raw text for the same reason.
  if next.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return (committed, join(committed, previous)) }
  // A result that already carries the committed text (a recognizer that DID keep it) is taken whole,
  // so nothing is ever said twice.
  // "Carries" is fuzzy: the recognizer may have REVISED the committed words while re-reading them
  // ("two" → "to"), so 80% of them in place at the front of the new result is enough. Below that
  // a revised copy could still be doubled — accepted, because treating a real restart as a copy
  // would drop words, and a doubled sentence is visible and fixable where a dropped one is not.
  if !committed.isEmpty {
    let cw = WhisperNoise.fold(committed).split(separator: " "), nw = WhisperNoise.fold(next).split(separator: " ")
    if nw.count >= cw.count {
      let same = zip(cw, nw).filter { $0 == $1 }.count
      if same * 5 >= cw.count * 4 { return ("", next) }
    }
  }
  let p = previous.split(separator: " "), n = next.split(separator: " ")
  let firstChanged = WhisperNoise.fold(String(p.first ?? "")) != WhisperNoise.fold(String(n.first ?? ""))
  let sentenceDone = previous.hasSuffix(".") || previous.hasSuffix("?") || previous.hasSuffix("!")
  // A restart: the text shrank by more than half and changed its first word or followed a finished
  // sentence ("…ready by then." → "After") — or a SHORT sentence ended and a new first word came
  // ("Yes." → "And"), which the halving rule cannot see. A first word revised mid-sentence
  // ("Four" → "For the") is neither.
  let restart = !n.isEmpty && (
    (p.count >= 2 && n.count * 2 < p.count && (firstChanged || sentenceDone))
    || (p.count >= 1 && firstChanged && (n.count < p.count || sentenceDone)))
  let c = restart ? join(committed, previous) : committed
  return (c, join(c, next))
}

/// Bug 185 x 189: whether a changed result moves the words' clock (the end-of-turn settle). A plain
/// partial always does (a closing "?" included, as before). A result that restarted or re-read the
/// stitched text only does when its words differ — the same words re-formatted are not new speech.
func partialMovesClock(old: String, new: String, stitched: Bool) -> Bool {
  old != new && (!stitched || WhisperNoise.fold(old) != WhisperNoise.fold(new))
}

/// Whether whisper looped: one word `loopRunWord`+ times running, or a 2-3 word phrase `loopRun`+.
/// A person says "no no no no"; whisper, looping, says "Finally." sixty-six times — the word
/// threshold sits between the two so the first never triggers the (costly) full-window re-pass.
func whisperLoops(_ text: String) -> Bool { repetitionRun(text, phraseMin: 2) >= WhisperLimit.loopRun || repetitionRun(text) >= WhisperLimit.loopRunWord }

/// Bug 185: dictation's own stop, after `idleMs` (10 s) with no new words — only once something was
/// heard (before that it is the no-speech rule's call), and never with a sentence still open or
/// whisper still reading one, so the stop can never cut a final short.
func dictationIdleStop(heardText: Bool, turnOpen: Bool, pending: Bool, sinceWordsMs: Double, idleMs: Double) -> Bool {
  heardText && !turnOpen && !pending && sinceWordsMs >= idleMs
}

/// "No speech detected": `noSpeechMs` (8 s) of audio and not one word — unchanged by bug 185, and
/// never while a first sentence is still open or in whisper (its final has not set `heardText` yet).
func dictationNoSpeech(heardText: Bool, turnOpen: Bool, pending: Bool, sinceAudioMs: Double, noSpeechMs: Double) -> Bool {
  !heardText && !turnOpen && !pending && sinceAudioMs >= noSpeechMs
}

/// Bug 185: once stopping, speech opens nothing new — the old helper started an utterance after
/// dictation's own stop and then never exited.
func mayStartUtterance(onset: Bool, stopping: Bool) -> Bool { onset && !stopping }

/// The closing words of the previous chunk, whole words only, as context for the next.
func contextTail(_ text: String, limit: Int = WhisperLimit.contextChars) -> String {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if t.count <= limit { return t }
  let cut = String(t.suffix(limit))
  guard let sp = cut.firstIndex(of: " ") else { return cut }
  return String(cut[cut.index(after: sp)...])
}

/// The longest run of one phrase of `phraseMin`...3 words (a single word by default) repeated back to back.
func repetitionRun(_ text: String, phraseMin: Int = 1) -> Int {
  let w = text.split(separator: " ").map { WhisperNoise.fold(String($0)) }.filter { !$0.isEmpty }
  var best = 1
  for n in phraseMin...3 where w.count >= 2 * n {
    var i = 0
    while i + n <= w.count {
      var run = 1
      while i + (run + 1) * n <= w.count && Array(w[(i + run * n)..<(i + (run + 1) * n)]) == Array(w[i..<(i + n)]) { run += 1 }
      best = max(best, run)
      i += run > 1 ? (run - 1) * n + 1 : 1
    }
  }
  return best
}

/// A loop cut back to what was said: every run of `WhisperLimit.loopRunWord` or more repeats of a
/// word, or `loopRun` of a 2-3 word phrase, keeps only its LAST copy (the one the next real words
/// follow on from). "no no no no" is left as the user said it.
func collapseRepeats(_ text: String) -> String {
  var tokens = text.split(separator: " ").map(String.init)
  for n in 1...3 {
    var i = 0
    while i + n <= tokens.count {
      let key = tokens[i..<(i + n)].map { WhisperNoise.fold($0) }
      var run = 1
      while i + (run + 1) * n <= tokens.count && tokens[(i + run * n)..<(i + (run + 1) * n)].map({ WhisperNoise.fold($0) }) == key { run += 1 }
      if run >= (n == 1 ? WhisperLimit.loopRunWord : WhisperLimit.loopRun) { tokens.removeSubrange(i..<(i + (run - 1) * n)) }
      i += 1
    }
  }
  return tokens.joined(separator: " ")
}

/// Whether the samples not yet handed to whisper are still kept (bug 185: ten minutes, not 30 s).
func whisperKeeps(samples: Int) -> Bool { samples <= WhisperLimit.maxSamples }

/// Whisper's stock filler on near-silence, and the bracketed sound tags it emits. A final made only
/// of these is not a transcript, whatever Apple heard.
enum WhisperNoise {
  static let phrases: Set<String> = [
    "thank you", "thanks for watching", "thank you for watching", "you", "bye",
    "thanks", "okay", "so", "the", "beep", "silence", "subscribe",
  ]
  /// Strip "[BLANK_AUDIO]", "(upbeat music)" and friends, then fold to bare words.
  static func fold(_ s: String) -> String {
    var t = s
    for pattern in ["\\[[^\\]]*\\]", "\\([^\\)]*\\)", "\\*[^\\*]*\\*", "♪[^♪]*♪"] {
      t = t.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
    }
    t = t.lowercased().filter { $0.isLetter || $0.isNumber || $0 == " " || $0 == "'" }
    return t.split(separator: " ").joined(separator: " ")
  }
  static func isNoise(_ s: String) -> Bool {
    let f = fold(s)
    return f.isEmpty || phrases.contains(f)
  }
}

/// Which transcript becomes the final. Pure, so the rule is a unit test and not a guess.
///
/// Whisper wins by default — that is the point of running it — but three things send the turn back
/// to Apple, because each of them is a way whisper is WORSE than a live recognizer rather than
/// better: it ran out of the latency budget, it came back with its stock near-silence filler, or it
/// came back a wildly different length from what Apple heard (the shape a hallucinated run takes).
/// Apple's text is never worse than nothing: it is the same text the user has been watching.
func whisperWins(apple: String, whisper: String?, elapsedMs: Double, budgetMs: Double, chunked: Bool = false) -> (text: String, engine: String, why: String) {
  let a = apple.trimmingCharacters(in: .whitespacesAndNewlines)
  guard let raw = whisper else { return (a, "apple", "failed") }
  let w = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  if elapsedMs > budgetMs { return (a, "apple", "timeout") }
  if w.isEmpty { return (a, "apple", "empty") }
  if WhisperNoise.isNoise(w) && !WhisperNoise.isNoise(a) { return (a, "apple", "noise") }
  // A length check, not a word check: we have no ground truth here, only two transcripts of the
  // same audio, so the only honest signal is that one of them is not the same utterance at all.
  // Bug 185: not for a CHUNKED turn — there the chunks were each checked for loops as they came
  // back, and Apple's text is the less trustworthy of the two (it restarts after pauses), so a
  // whisper transcript far longer than Apple's is more likely the words Apple lost than a loop.
  if chunked { return (w, "whisper", "ok") }
  let aw = max(1, WhisperNoise.fold(a).split(separator: " ").count)
  let ww = WhisperNoise.fold(w).split(separator: " ").count
  if ww * 5 < aw * 2 { return (a, "apple", "short") }       // under 40% of Apple's words
  if ww * 2 > aw * 5 { return (a, "apple", "long") }        // over 250% of Apple's words
  return (w, "whisper", "ok")
}

// ---------- the engine ----------

#if WHISPER

/// One loaded whisper model for the life of the helper. Loading happens on `loadQ` at start, so the
/// first end-of-turn finds it ready; transcription happens on `runQ`, never on the pipeline queue,
/// so a 500 ms encode cannot stall the microphone.
final class WhisperEngine {
  private var ctx: OpaquePointer?
  private let lock = NSLock()
  private let runQ = DispatchQueue(label: "bots-dictation.whisper")
  private let loadQ = DispatchQueue(label: "bots-dictation.whisper.load")
  private var loaded = false
  private var failed = false
  let model: String
  let prompt: String
  let beam: Int
  let autoCtx: Bool
  let fixedCtx: Int32
  /// The prompt and the language as C strings that outlive every call: `whisper_full_params` holds
  /// raw pointers, and a Swift string's buffer is only valid inside a `withCString` body.
  private let promptC: UnsafeMutablePointer<CChar>?
  private let langC: UnsafeMutablePointer<CChar>

  var isReady: Bool { lock.lock(); defer { lock.unlock() }; return loaded }
  var isFailed: Bool { lock.lock(); defer { lock.unlock() }; return failed }

  init(model: String, prompt: String, beam: Int, audioCtx: Int32, locale: String) {
    self.model = model
    self.prompt = prompt
    self.beam = beam
    self.autoCtx = audioCtx <= 0
    self.fixedCtx = audioCtx
    self.promptC = prompt.isEmpty ? nil : strdup(prompt)
    self.langC = strdup(String(locale.prefix(2)).lowercased())
  }

  /// Load in the background. Never throws, never blocks: a failure just leaves `isReady` false.
  func warm(_ done: (() -> Void)? = nil) {
    loadQ.async { [self] in
      let started = nowMs()
      var cp = whisper_context_default_params()
      cp.use_gpu = true
      cp.flash_attn = true
      guard FileManager.default.fileExists(atPath: model), let c = whisper_init_from_file_with_params(model, cp) else {
        lock.lock(); failed = true; lock.unlock()
        log("whisper unavailable: \(model) could not be loaded; Apple's transcript stands")
        emit(["type": "whisper", "ok": false, "reason": "load-failed"])
        done?()
        return
      }
      lock.lock(); ctx = c; loaded = true; lock.unlock()
      let ms = Int(nowMs() - started)
      log("whisper ready in \(ms) ms (\(URL(fileURLWithPath: model).lastPathComponent), Metal, prompt \(prompt.count) chars)")
      emit(["type": "whisper", "ok": true, "ms": ms, "model": URL(fileURLWithPath: model).lastPathComponent])
      done?()
    }
  }

  /// Re-transcribe one finished utterance off the pipeline queue. `budgetMs` is enforced inside the
  /// graph: the abort callback stops the encode the moment it runs out, so a slow machine costs the
  /// budget and not a second more. The completion always runs, exactly once.
  ///
  /// Bug 185: `context` is read on the whisper queue just before this chunk runs — so it sees the
  /// chunk before it, which ran first on the same serial queue — and its closing words follow the
  /// names in the prompt, so a sentence that runs across a seam carries on as one sentence.
  func transcribe(_ pcm: [Float], budgetMs: Double, context: (() -> String?)? = nil, then finish: @escaping (String?, Double) -> Void) {
    guard isReady else { finish(nil, 0); return }
    runQ.async { [self] in
      lock.lock(); let c = ctx; lock.unlock()
      guard let c else { finish(nil, 0); return }
      var p = whisper_full_default_params(beam > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY)
      p.n_threads = Int32(min(6, max(1, ProcessInfo.processInfo.activeProcessorCount - 2)))
      p.no_timestamps = true
      p.print_progress = false
      p.print_realtime = false
      p.print_timestamps = false
      p.print_special = false
      // One utterance, one segment. Without this whisper keeps opening new segments over the same
      // audio and repeats the sentence — measured 13 copies of a 3.7 s line at a tight audio_ctx.
      p.single_segment = true
      p.translate = false
      p.no_context = true // each utterance stands alone; the previous one is not context for it
      p.suppress_blank = true
      p.temperature_inc = 0 // no fallback sweep: a retry at a higher temperature blows the budget
      if beam > 1 { p.beam_search.beam_size = Int32(beam) }
      p.audio_ctx = autoCtx ? whisperAudioCtx(samples: pcm.count) : fixedCtx
      // The language is the session's, never detected: detection costs an extra encode pass.
      p.language = UnsafePointer(langC)
      var dynamicPrompt: UnsafeMutablePointer<CChar>? = nil
      defer { free(dynamicPrompt) }
      if let tail = context?().map({ contextTail($0) }), !tail.isEmpty {
        dynamicPrompt = strdup(prompt.isEmpty ? tail : prompt + " " + tail)
        p.initial_prompt = UnsafePointer(dynamicPrompt!)
      } else if let promptC { p.initial_prompt = UnsafePointer(promptC) }
      // The budget is enforced INSIDE the graph. A C function pointer cannot capture, so the
      // deadline lives in a global that only this serialised queue writes.
      p.abort_callback = { _ in
        guard whisperDeadline > 0, nowMs() > whisperDeadline else { return false }
        whisperAborted = true
        return true // true aborts the graph
      }
      func attempt(_ audioCtx: Int32) -> (String?, Double) {
        let t = nowMs()
        p.audio_ctx = audioCtx
        whisperDeadline = t + budgetMs
        whisperAborted = false
        let rc = pcm.withUnsafeBufferPointer { whisper_full(c, p, $0.baseAddress, Int32($0.count)) }
        let aborted = whisperAborted
        whisperDeadline = 0
        guard rc == 0 && !aborted else { return (nil, nowMs() - t) }
        var text = ""
        for i in 0..<whisper_full_n_segments(c) {
          guard let s = whisper_full_get_segment_text(c, i) else { continue }
          text += String(cString: s)
        }
        return (text.trimmingCharacters(in: .whitespacesAndNewlines), nowMs() - t)
      }
      var (out, ms) = attempt(p.audio_ctx)
      // Bug 185: whisper can fall into a loop at the end of a long stretch — measured on a 23.9 s
      // chunk at audio_ctx 1280: "Finally." SIXTY-FIVE times. The same audio over the full window
      // came back clean, so a looping pass is run once more at 1500 with a fresh budget (on this
      // queue: while the user talks for a chunk, only at the end for the tail). If that loops too,
      // or fails, the run is collapsed to one — never shipped as it came.
      if let o = out, whisperLoops(o) {
        log("whisper repeated itself (\(repetitionRun(o))x) at audio_ctx \(p.audio_ctx); once more over the full window")
        if p.audio_ctx < 1500, case let (again?, ms2) = attempt(1500), !whisperLoops(again) {
          out = again; ms = ms2
        } else {
          out = collapseRepeats(o)
        }
      }
      finish(out, ms)
    }
  }

  func close() {
    lock.lock()
    let c = ctx
    ctx = nil
    loaded = false
    lock.unlock()
    if let c { whisper_free(c) }
  }

  /// `--whisper-bench FILE`: load, transcribe one 16 kHz mono WAV and print the result as JSON.
  /// No Speech access, no microphone, no realtime feeding — this is what the accuracy sweep drives,
  /// so the numbers come from exactly the code a session runs.
  func benchOne(path: String, budgetMs: Double, names: [String], _ done: @escaping ([String: Any]) -> Void) {
    guard let pcm = readWav16k(path) else { done(["type": "whisper-bench", "ok": false, "reason": "unreadable"]); return }
    transcribe(pcm, budgetMs: budgetMs) { [self] text, ms in
      let raw = text ?? ""
      let corrected = postCorrect(raw, names: names, commands: true)
      done([
        "type": "whisper-bench", "ok": text != nil, "file": URL(fileURLWithPath: path).lastPathComponent,
        "raw": raw, "text": corrected, "ms": Int(ms), "samples": pcm.count,
        "audioCtx": Int(autoCtx ? whisperAudioCtx(samples: pcm.count) : fixedCtx),
        "promptChars": prompt.count, "beam": beam,
      ])
    }
  }
}

/// A 16-bit PCM WAV at 16 kHz mono, as `afconvert` writes it, into the float samples whisper wants.
/// Bench-only: a session never reads a file, it already holds the microphone's own float buffers.
func readWav16k(_ path: String) -> [Float]? {
  guard let d = FileManager.default.contents(atPath: path), d.count > 44 else { return nil }
  // Walk the RIFF chunks rather than assuming a 44-byte header.
  var i = 12
  while i + 8 <= d.count {
    let id = String(bytes: d[d.startIndex + i..<d.startIndex + i + 4], encoding: .ascii) ?? ""
    let size = d.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: i + 4, as: UInt32.self) }
    let body = i + 8
    if id == "data" {
      let end = min(d.count, body + Int(size))
      guard end > body else { return nil }
      let n = (end - body) / 2
      var out = [Float](repeating: 0, count: n)
      d.withUnsafeBytes { r in
        for k in 0..<n {
          let s = r.loadUnaligned(fromByteOffset: body + k * 2, as: Int16.self)
          out[k] = Float(s) / 32768.0
        }
      }
      return out
    }
    i = body + Int(size) + (Int(size) % 2)
  }
  return nil
}

/// The running transcription's deadline in helper-clock ms, and whether the budget cut it short —
/// read and written by the C abort callback, which cannot capture. Only one transcription runs at a
/// time (they are serialised on `runQ`), so a global is the whole of the synchronisation needed.
nonisolated(unsafe) var whisperDeadline: Double = 0
nonisolated(unsafe) var whisperAborted = false

/// Silence ggml's own chatter unless the helper is being debugged: it writes hundreds of lines per
/// load and the app keeps the tail of stderr to explain failures to the user.
func whisperQuiet() {
  if ProcessInfo.processInfo.environment["SYNAPSE_WHISPER_LOG"] == "1" { return }
  whisper_log_set({ _, _, _ in }, nil)
}

#else

/// Built without the whisper libraries: every call is a no-op and `isReady` never becomes true, so
/// `Pipeline.complete` takes exactly the path it took before bug 165.
final class WhisperEngine {
  let model: String, prompt: String, beam: Int, autoCtx: Bool, fixedCtx: Int32
  var isReady: Bool { false }
  var isFailed: Bool { true }
  init(model: String, prompt: String, beam: Int, audioCtx: Int32, locale: String) {
    self.model = model; self.prompt = prompt; self.beam = beam; self.autoCtx = audioCtx <= 0; self.fixedCtx = audioCtx
  }
  func warm(_ done: (() -> Void)? = nil) {
    log("whisper not built into this helper; Apple's transcript stands")
    emit(["type": "whisper", "ok": false, "reason": "not-built"])
    done?()
  }
  func transcribe(_ pcm: [Float], budgetMs: Double, context: (() -> String?)? = nil, then finish: @escaping (String?, Double) -> Void) { finish(nil, 0) }
  func close() {}
  func benchOne(path: String, budgetMs: Double, names: [String], _ done: @escaping ([String: Any]) -> Void) {
    done(["type": "whisper-bench", "ok": false, "reason": "not-built"])
  }
}

func whisperQuiet() {}

#endif



/// Bug 162: the recognizer's contextual strings, tidied and capped. Duplicates and case variants
/// collapse, anything too long or too short to bias on is dropped, and the cap keeps the list within
/// what the recognizer will actually weigh (a huge list dilutes every entry and costs setup time).
/// A static, not a global: the self-tests run before the top-level globals are initialized.
enum ContextLimit { static let cap = 300 }
func cleanContext(_ raw: [String]) -> [String] {
  var seen = Set<String>()
  var out: [String] = []
  for s in raw {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.count >= 2, t.count <= 60, t.contains(where: { $0.isLetter }) else { continue }
    let key = t.lowercased()
    if seen.contains(key) { continue }
    seen.insert(key)
    out.append(t)
    if out.count >= ContextLimit.cap { break }
  }
  return out
}

/// Bug 162: read the session's contextual strings from a JSON file — either a bare array of strings
/// or {"strings": [...]}. A missing or malformed file is not fatal: the session just runs unbiased.
func readContextFile(_ path: String) -> [String] {
  guard let d = FileManager.default.contents(atPath: path) else { log("context file unreadable: \(path)"); return [] }
  let obj = try? JSONSerialization.jsonObject(with: d)
  let raw = (obj as? [String]) ?? ((obj as? [String: Any])?["strings"] as? [String]) ?? []
  let cleaned = cleanContext(raw)
  log("context: \(cleaned.count) strings from \(raw.count)")
  return cleaned
}

// ---------- the custom language model (bug 162) ----------
// Contextual strings bias one recognition; a custom language model teaches the recognizer the
// user's whole vocabulary and the shapes they say it in. Measured together on the same 36 samples:
// contextual strings alone 6.9% WER / 48 of 54 names, both together 5.2% / 51 of 54. It costs about
// a second to compile and a few megabytes on disk, so the app builds it once and caches it, and
// rebuilds only when the Bot or contact list actually changes.

/// The command shapes the user speaks a name inside. `<name>` stands for any of the session's names,
/// which is what makes this more than a bag of words: "call Nova" teaches the run of words, not just
/// "Nova". Kept short on purpose — every template multiplies out by the whole name list.
enum LMTemplates {
  static let shapes = [
    "call <name>", "ask <name>", "tell <name>", "text <name>", "message <name>",
    "add <name> to the call", "drop <name>", "get <name> on the call",
    "open <name>", "restart <name>", "check <name>", "what did <name> say",
    "send <name> the", "<name> said", "about <name>",
  ]
}

/// Build and compile a custom language model from the session's names, then exit. Writes
/// `model.lm` / `model.vocab` into `--lm-dir`, which a later session passes back with `--lm-dir`.
func runBuildLM() -> Never {
  guard #available(macOS 14.0, *) else {
    emit(["type": "lm", "ok": false, "reason": "unsupported"])
    leave(0) // not an error: the session simply runs on contextual strings alone
  }
  guard let dir = opt.lmDir else { fail("lm", "--build-lm needs --lm-dir.", 4) }
  let names = opt.context
  guard !names.isEmpty else { emit(["type": "lm", "ok": false, "reason": "no-names"]); leave(0) }
  let sem = DispatchSemaphore(value: 0)
  let started = nowMs()
  Task {
    do {
      try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
      let data = SFCustomLanguageModelData(locale: Locale(identifier: opt.locale),
                                           identifier: "com.nyfeblade.synapse.dictation.lm",
                                           version: "1")
      // The name on its own, weighted heavily: this is what the user says most and it is what the
      // stock model has never heard.
      for n in names { data.insert(phraseCount: .init(phrase: n, count: 80)) }
      // The name inside the shapes it is said in.
      data.insert(phraseCountGenerator: SFCustomLanguageModelData.TemplatePhraseCountGenerator.of(
        shapes: LMTemplates.shapes, names: names))
      let asset = URL(fileURLWithPath: dir).appendingPathComponent("lm.bin")
      try await data.export(to: asset)
      try await SFSpeechLanguageModel.prepareCustomLanguageModel(for: asset, configuration: lmConfig(dir), ignoresCache: true)
      emit(["type": "lm", "ok": true, "names": names.count, "ms": Int(nowMs() - started)])
      sem.signal()
    } catch {
      // Never fatal: a session without a language model still has its contextual strings.
      emit(["type": "lm", "ok": false, "reason": "\(error)"])
      sem.signal()
    }
  }
  _ = sem.wait(timeout: .now() + 120)
  leave(0)
}

@available(macOS 14.0, *)
func lmConfig(_ dir: String) -> SFSpeechLanguageModel.Configuration {
  SFSpeechLanguageModel.Configuration(
    languageModel: URL(fileURLWithPath: dir).appendingPathComponent("model.lm"),
    vocabulary: URL(fileURLWithPath: dir).appendingPathComponent("model.vocab"))
}

@available(macOS 14.0, *)
extension SFCustomLanguageModelData.TemplatePhraseCountGenerator {
  /// `<name>` in each shape expands over every name in the session's list.
  static func of(shapes: [String], names: [String]) -> SFCustomLanguageModelData.TemplatePhraseCountGenerator {
    let g = SFCustomLanguageModelData.TemplatePhraseCountGenerator()
    g.define(className: "name", values: names)
    for s in shapes { g.insert(template: s, count: 20) }
    return g
  }
}

// ---------- bug 165: the whisper accuracy sweep ----------
/// `--whisper-bench FILE`: load the model, re-transcribe one WAV, print JSON, exit. Needs no Speech
/// access and no microphone, so the sweep runs unattended — and it runs the SAME engine, prompt and
/// post-correction a live utterance does, which is what makes the measured numbers mean anything.
func runWhisperBench() -> Never {
  guard let file = opt.whisperBench else { fail("whisper", "--whisper-bench needs a file.", 4) }
  guard let model = opt.whisperModel else { fail("whisper", "--whisper-bench needs --whisper-model.", 4) }
  whisperQuiet()
  let prompt = opt.whisperPrompt ? whisperPrompt(opt.context) : ""
  let engine = WhisperEngine(model: model, prompt: prompt, beam: opt.whisperBeam, audioCtx: opt.whisperAudioCtx, locale: opt.locale)
  let sem = DispatchSemaphore(value: 0)
  engine.warm {
    guard engine.isReady else { emit(["type": "whisper-bench", "ok": false, "reason": "load-failed"]); sem.signal(); return }
    // A budget the sweep never trips: the sweep is measuring how long whisper TAKES, and a budget
    // that cut it short would hide exactly the number being looked for.
    engine.benchOne(path: file, budgetMs: 600_000, names: opt.context) { o in emit(o); sem.signal() }
  }
  _ = sem.wait(timeout: .now() + 900)
  leave(0)
}

func runTextSelfTest() -> Never {
  var cases = 0
  var failures: [String] = []
  func check(_ name: String, _ ok: Bool) { cases += 1; if !ok { failures.append(name); log("FAIL \(name)") } }
  let names = ["Disk Saver", "Priya", "Kokoro", "OrbStack", "Synapse", "Nova"]

  // --- spoken commands ---
  check("period", applySpokenCommands("hello there period") == "hello there.")
  check("comma then more", applySpokenCommands("hello comma world") == "hello, world")
  check("question mark", applySpokenCommands("are you there question mark") == "are you there?")
  check("new line", applySpokenCommands("one new line two") == "one\ntwo")
  check("new paragraph", applySpokenCommands("one new paragraph two") == "one\n\ntwo")
  check("paragraph beats line", applySpokenCommands("a new paragraph b") == "a\n\nb")
  check("full stop", applySpokenCommands("done full stop") == "done.")
  check("delete that drops one word", applySpokenCommands("send it to Bob delete that Priya") == "send it to Priya")
  check("delete that after a mark", applySpokenCommands("hello there period delete that world") == "hello world")
  check("scratch that clears the sentence", applySpokenCommands("one two period three four scratch that five") == "one two. five")
  check("scratch that at the start", applySpokenCommands("one two scratch that three") == "three")
  check("commands survive addsPunctuation", applySpokenCommands("hello there, period.") == "hello there.")
  check("a real word is not a command", applySpokenCommands("the comma splice is wrong") == "the, splice is wrong")
  check("no command, no change", applySpokenCommands("just some ordinary words") == "just some ordinary words")
  check("empty", applySpokenCommands("") == "")

  // --- filler ---
  check("um in the middle", stripFiller("I think um we should go") == "I think we should go")
  check("um with a comma", stripFiller("Um, I think we should go") == "I think we should go")
  check("filler only is left alone", stripFiller("um") == "um")
  check("umbrella is not um", stripFiller("pass the umbrella") == "pass the umbrella")
  check("nothing to strip", stripFiller("a clean sentence") == "a clean sentence")

  // --- names ---
  check("Kakoro to Kokoro", fixNames("tell me about Kakoro", names: names) == "tell me about Kokoro")
  check("orb stack to OrbStack", fixNames("open orb stack now", names: names) == "open OrbStack now")
  check("disc saver to Disk Saver", fixNames("ask disc saver", names: names) == "ask Disk Saver")
  check("keeps the punctuation", fixNames("about Kakoro.", names: names) == "about Kokoro.")
  check("already right", fixNames("about Kokoro", names: names) == "about Kokoro")
  check("a far word is untouched", fixNames("about elephants", names: names) == "about elephants")
  check("short names are not corrected", fixNames("a nove idea", names: ["Nova"]) == "a nove idea")
  check("no names, no change", fixNames("about Kakoro", names: []) == "about Kakoro")

  // --- units ---
  check("gigabytes", fixUnits("42 gigabytes free") == "42 GB free")
  check("milliseconds", fixUnits("set it to 700 milliseconds") == "set it to 700 ms")
  check("point five", fixUnits("8 point 5 gigabytes") == "8.5 GB")
  check("bare unit is left as words", fixUnits("how many gigabytes") == "how many gigabytes")
  check("percent", fixUnits("at 50 percent") == "at 50 %")

  // --- the whole fixer ---
  check("end to end", postCorrect("um, ask disc saver about Kakoro period", names: names, commands: true) == "ask Disk Saver about Kokoro.")
  check("commands off for calls", postCorrect("say period out loud", names: names, commands: false) == "say period out loud")

  // --- contextual strings ---
  check("context dedupes by case", cleanContext(["Nova", "nova", "Atlas"]) == ["Nova", "Atlas"])
  check("context drops the empty and the tiny", cleanContext(["", "a", "Nova", "  "]) == ["Nova"])
  check("context drops the digits-only", cleanContext(["1234", "Nova"]) == ["Nova"])
  check("context drops the over-long", cleanContext([String(repeating: "x", count: 61), "Nova"]) == ["Nova"])
  check("context trims", cleanContext(["  Nova  "]) == ["Nova"])
  check("context caps", cleanContext((1...400).map { "Name\($0)" }).count == ContextLimit.cap)


  // --- bug 165: the whisper hybrid. Pure rules only — no model is loaded here, which is the point:
  // these are the decisions that keep a missing or slow whisper from ever costing the user a word.
  check("prompt: the session's vocabulary, comma separated", whisperPrompt(["Nova", "OrbStack"]) == "Nova, OrbStack.")
  check("prompt: nothing to say about an empty list", whisperPrompt([]).isEmpty)
  check("prompt: blank and overlong entries are dropped", whisperPrompt(["  ", String(repeating: "x", count: 60), "Nova"]) == "Nova.")
  let manyNames = (0..<200).map { "Name\($0)" }
  check("prompt: capped well inside whisper's token budget", whisperPrompt(manyNames).count <= WhisperLimit.promptChars + 1)
  check("prompt: the cap keeps whole names, never half of one", !whisperPrompt(manyNames).contains("Name1,,"))

  check("audio-ctx: a short turn still gets the measured floor", whisperAudioCtx(samples: 16_000 * 3) == 768)
  check("audio-ctx: never below the floor that made it repeat", whisperAudioCtx(samples: 800) == 768)
  check("audio-ctx: a long turn scales up", whisperAudioCtx(samples: 16_000 * 25) > 768)
  check("audio-ctx: never past one encoder window", whisperAudioCtx(samples: 16_000 * 120) == 1500)

  check("noise: whisper's stock filler on silence is not a transcript", WhisperNoise.isNoise("Thank you."))
  check("noise: a bracketed sound tag is not a transcript", WhisperNoise.isNoise(" [BLANK_AUDIO] "))
  check("noise: real words are not noise", !WhisperNoise.isNoise("open OrbStack please"))

  check("hybrid: whisper's words win", whisperWins(apple: "ask disc saver", whisper: "ask Disk Saver", elapsedMs: 400, budgetMs: 900).engine == "whisper")
  check("hybrid: past the budget, Apple's text stands", whisperWins(apple: "ask disc saver", whisper: "ask Disk Saver", elapsedMs: 1200, budgetMs: 900).text == "ask disc saver")
  check("hybrid: the timeout says so", whisperWins(apple: "a b c", whisper: "x y z", elapsedMs: 1200, budgetMs: 900).why == "timeout")
  check("hybrid: whisper failing is not a lost turn", whisperWins(apple: "ask disc saver", whisper: nil, elapsedMs: 40, budgetMs: 900).text == "ask disc saver")
  check("hybrid: an empty whisper is not a lost turn", whisperWins(apple: "ask disc saver", whisper: "   ", elapsedMs: 40, budgetMs: 900).text == "ask disc saver")
  check("hybrid: whisper's silence filler never replaces real words",
        whisperWins(apple: "open OrbStack and restart Kokoro", whisper: "Thank you.", elapsedMs: 200, budgetMs: 900).engine == "apple")
  check("hybrid: a run far shorter than Apple heard is not the same utterance",
        whisperWins(apple: "one two three four five six seven eight", whisper: "one two", elapsedMs: 200, budgetMs: 900).why == "short")
  check("hybrid: a repeated run far longer than Apple heard is rejected",
        whisperWins(apple: "one two three", whisper: String(repeating: "one two three ", count: 8), elapsedMs: 200, budgetMs: 900).why == "long")
  check("hybrid: a fair rewording of the same length is accepted",
        whisperWins(apple: "ask disc saver to check orb stack", whisper: "Ask Disk Saver to check OrbStack.", elapsedMs: 300, budgetMs: 900).engine == "whisper")
  // The whole reason whisper's raw text is not shipped as-is: post-correction is what puts the
  // user's own spelling back, on whichever engine won the turn.
  let names165 = ["Disk Saver", "OrbStack", "Kokoro"]
  check("hybrid: post-correction still restores names in whisper's text",
        postCorrect("ask disk saver to check orb stack", names: names165, commands: true) == "ask Disk Saver to check OrbStack")
  check("hybrid: spoken commands still work on whisper's text",
        postCorrect("open OrbStack new line then Kokoro", names: names165, commands: true).contains("\n"))

  // --- bug 185: an entire speech, however long. Each of these is one of the measured causes.
  // (1) The budget: 900 ms was set on 4 s clips; a 26 s utterance aborted at 900 ms every time.
  check("budget: a short turn keeps the measured budget", whisperBudget(baseMs: 900, samples: 16_000 * 4) == 900)
  check("budget: grows with the audio", whisperBudget(baseMs: 900, samples: 16_000 * 20) > whisperBudget(baseMs: 900, samples: 16_000 * 10))
  check("budget: a full 28 s chunk gets twice its measured 1132 ms, not the 900 ms that aborted it",
        whisperBudget(baseMs: 900, samples: WhisperLimit.chunkSamples) >= 2_200)
  check("budget: still bounded (a stop never waits forever)", whisperBudget(baseMs: 900, samples: 16_000 * 600) <= WhisperLimit.maxBudgetMs)
  check("budget: a background chunk's is still bounded", whisperBudget(baseMs: 900, samples: WhisperLimit.chunkSamples) * WhisperLimit.backgroundBudgetFactor <= 2 * WhisperLimit.maxBudgetMs)
  // (2) The window: whisper reads 30 s at a time; a longer turn is cut into chunks at a quiet point.
  var speech = [Float](repeating: 0.3, count: 16_000 * 40)
  for k in (16_000 * 26)..<(16_000 * 26 + 3_200) { speech[k] = 0.0005 } // a 200 ms gap between words at 26 s
  let cut = whisperCut(speech, from: 0, maxLen: WhisperLimit.chunkSamples, search: WhisperLimit.chunkSearchSamples)
  check("chunk: cut inside the gap between words, never through a word", cut > 16_000 * 26 && cut < 16_000 * 26 + 3_200)
  check("chunk: never past one encoder window", cut <= WhisperLimit.chunkSamples)
  let flat = [Float](repeating: 0.3, count: 16_000 * 40)
  let hard = whisperCut(flat, from: 16_000, maxLen: WhisperLimit.chunkSamples, search: WhisperLimit.chunkSearchSamples)
  check("chunk: no gap at all still cuts inside the window", hard > 16_000 && hard <= 16_000 + WhisperLimit.chunkSamples)
  // (3) The seams: nothing dropped, nothing said twice.
  check("stitch: joins the chunks in order", stitchWhisper(["I want to plan the week.", "On Monday I have a review."]) == "I want to plan the week. On Monday I have a review.")
  check("stitch: a seam whisper repeated is said once",
        stitchWhisper(["and I need the new sidebar shots", "the new sidebar shots ready by then."]) == "and I need the new sidebar shots ready by then.")
  check("stitch: a real repeated word is not a seam", stitchWhisper(["I said no", "no more today."]) == "I said no no more today.")
  check("stitch: an empty or filler chunk leaves no gap", stitchWhisper(["one two", "  ", "[BLANK_AUDIO]", "three four"]) == "one two three four")
  // (4) Apple's own transcript: after a pause the on-device recognizer starts its text over
  // (measured: "…ready by then." → "After"), and everything before the pause was lost.
  let before = "I want to plan the week. On Monday I have the review and I need the shots ready by then."
  check("apple: a restart after a pause keeps what came before",
        mergeAppleResult(committed: "", previous: before, next: "After").text == before + " After")
  check("apple: a growing partial just grows", mergeAppleResult(committed: "", previous: "I want to", next: "I want to plan").text == "I want to plan")
  check("apple: a revision is a revision, not a restart", mergeAppleResult(committed: "", previous: "I want two plan", next: "I want to plan the").text == "I want to plan the")
  check("apple: a second restart keeps both", mergeAppleResult(committed: "One. Two three four five.", previous: "Six seven eight nine ten.", next: "Eleven").text
        == "One. Two three four five. Six seven eight nine ten. Eleven")
  check("apple: a result that already holds the whole text is not doubled",
        mergeAppleResult(committed: "One two three.", previous: "Four five", next: "One two three. Four five six").text == "One two three. Four five six")
  // (6) Whisper looping at the end of a long chunk (measured: "Finally." 65 times on a 23.9 s chunk).
  let looped = "hide the switches behind a row at the bottom. " + String(repeating: "Finally. ", count: 65) + "Finally I want us to measure it."
  check("loop: a word said 65 times running is a loop", whisperLoops(looped))
  check("loop: a phrase looping is a loop", whisperLoops("and then we go " + String(repeating: "to the shop ", count: 6)))
  check("loop: ordinary speech is not", !whisperLoops("no, no, I said the other one, the red one"))
  check("loop: collapsed to the words that were said", collapseRepeats(looped) == "hide the switches behind a row at the bottom. Finally I want us to measure it.")
  check("loop: collapsing leaves ordinary speech alone", collapseRepeats("no, no, I said the other one") == "no, no, I said the other one")
  // --- bug 185 review ---
  check("apple: a one-word sentence before a pause is kept (\"Yes.\" then \"And\")",
        mergeAppleResult(committed: "", previous: "Yes.", next: "And").text == "Yes. And")
  check("apple: a first word revised mid-sentence is a revision", mergeAppleResult(committed: "", previous: "Four", next: "For the").text == "For the")
  check("apple: a result that carries a REVISED copy of the committed text is taken whole",
        mergeAppleResult(committed: "I want two plan the week.", previous: "Then more", next: "I want to plan the week. Then more words").text
          == "I want to plan the week. Then more words")
  // Final fix wave: an empty or whitespace-only result (Apple sends one between stretches) is not a
  // restart and not new text — it must never drop what the utterance already said.
  check("apple: an empty result keeps what was said",
        mergeAppleResult(committed: "One two.", previous: "Three four", next: "").text == "One two. Three four")
  check("apple: a whitespace result keeps what was said and commits nothing new",
        mergeAppleResult(committed: "", previous: "Three four", next: "  ") == (committed: "", text: "Three four"))
  check("loop: \"no no no no\" is how people talk, not a loop", !whisperLoops("I said no no no no to that"))
  check("loop: one word six times running is a loop", whisperLoops("and " + String(repeating: "Finally. ", count: 6)))
  check("loop: a phrase four times running is a loop", whisperLoops(String(repeating: "to the shop ", count: 4)))
  check("loop: collapsing keeps a short run of a word", collapseRepeats("no no no no, I said") == "no no no no, I said")
  check("hybrid: a chunked turn is not judged by length against Apple's text",
        whisperWins(apple: "one two three", whisper: String(repeating: "four five six ", count: 8), elapsedMs: 200, budgetMs: 900, chunked: true).engine == "whisper")
  check("idle stop: dictation stops after 10 s with no new words", dictationIdleStop(heardText: true, turnOpen: false, pending: false, sinceWordsMs: 10_000, idleMs: 10_000))
  check("idle stop: not at 9.9 s", !dictationIdleStop(heardText: true, turnOpen: false, pending: false, sinceWordsMs: 9_900, idleMs: 10_000))
  check("idle stop: never while a sentence is open", !dictationIdleStop(heardText: true, turnOpen: true, pending: false, sinceWordsMs: 60_000, idleMs: 10_000))
  check("idle stop: never while whisper is still reading one", !dictationIdleStop(heardText: true, turnOpen: false, pending: true, sinceWordsMs: 60_000, idleMs: 10_000))
  check("idle stop: before any words it is the no-speech rule's call", !dictationIdleStop(heardText: false, turnOpen: false, pending: false, sinceWordsMs: 60_000, idleMs: 10_000))
  check("no speech: 8 s of audio and not a word ends it", dictationNoSpeech(heardText: false, turnOpen: false, pending: false, sinceAudioMs: 8_000, noSpeechMs: 8_000))
  check("no speech: not at 7.9 s", !dictationNoSpeech(heardText: false, turnOpen: false, pending: false, sinceAudioMs: 7_900, noSpeechMs: 8_000))
  check("no speech: never once words were heard", !dictationNoSpeech(heardText: true, turnOpen: false, pending: false, sinceAudioMs: 60_000, noSpeechMs: 8_000))
  check("no speech: never while a first sentence is still being read", !dictationNoSpeech(heardText: false, turnOpen: false, pending: true, sinceAudioMs: 60_000, noSpeechMs: 8_000))
  check("stop: speech after a stop opens nothing new", !mayStartUtterance(onset: true, stopping: true))
  check("stop: speech before it does", mayStartUtterance(onset: true, stopping: false) && !mayStartUtterance(onset: false, stopping: false))
  // Measured (p90, a 24.8 s chunk): whisper re-read an 11-word sentence of its context prompt.
  check("stitch: a whole repeated sentence at the seam is said once",
        stitchWhisper(["the settings page. We should group it into four sections, put the voice options together.",
                       "We should group it into four sections, put the voice options together. And hide the switches."])
          == "the settings page. We should group it into four sections, put the voice options together. And hide the switches.")
  // (5) The buffer: a three-minute speech is kept whole for whisper, not dropped at 30 s.
  check("buffer: a three-minute speech is kept", whisperKeeps(samples: 16_000 * 180))

  emit(["type": "self-test", "ok": failures.isEmpty, "cases": cases, "failures": failures])
  exit(failures.isEmpty ? 0 : 1)
}

/// Barge-in while the Bot speaks: only sustained speech (≥ sustainMs of voiced frames) above an
/// adaptive threshold — the noise floor, raised to the echo the playback is expected to leave in the
/// microphone (playback level + the learned echo coupling + a margin) — and never in the first
/// holdoffMs of audio out, when the echo canceller is still converging.
enum BargeDecision: Equatable { case none, accept(String), ignore(String) }
struct BargeGate {
  var holdoffMs = 250.0
  var sustainMs = 300.0
  /// Plan item 26 (call-behaviour): in the Bot's silence between two sentences (nothing audible for gapAfterMs
  /// before the user's onset) there is no echo to mistake for a voice, so a shorter run of voice takes the floor.
  var gapSustainMs = 150.0
  var gapAfterMs = 100.0
  /// Review round 1: the route's reported output latency — the Bot's last sound is still reaching the ear (and the
  /// mic) this long after the playback timeline went quiet — and whether the gap rule applies at all (not on
  /// Bluetooth or AirPlay, whose latency and echo path are too uncertain).
  var outputLatencyMs = 0.0
  var gapRule = true
  var marginDb = 10.0
  /// How long the playback has been silent (no buffer, or one below -70 dB), including the user's own run.
  private var quietMs = 0.0
  /// Microphone level minus playback level while only the Bot is audible (dB); learned per call.
  var coupling = -25.0
  var voicedMs = 0.0
  private var ignoredHoldoff = false
  mutating func reset() { voicedMs = 0; ignoredHoldoff = false; quietMs = 0 }
  func threshold(floorDb: Double, playDb: Double?) -> Double {
    let base = max(floorDb + 20, -38)
    guard let p = playDb else { return base }
    return max(base, p + coupling + marginDb)
  }
  /// One 20 ms frame. sinceOutMs: time since the reply's first audio out (nil = none played yet).
  mutating func frame(db: Double, playDb: Double?, sinceOutMs: Double?, floorDb: Double, frameMs: Double) -> BargeDecision {
    let th = threshold(floorDb: floorDb, playDb: playDb)
    quietMs = (playDb ?? -100) < -70 ? quietMs + frameMs : 0
    if let s = sinceOutMs, s < holdoffMs {
      // Only the Bot should be audible now: learn how loud its echo is, and don't count anything.
      if let p = playDb { coupling = min(0, max(-60, coupling * 0.9 + (db - p) * 0.1)) }
      voicedMs = 0
      if db > th && !ignoredHoldoff { ignoredHoldoff = true; return .ignore(String(format: "within the first %d ms of speech (mic %.1f dB, threshold %.1f dB)", Int(holdoffMs), db, th)) }
      return .none
    }
    if db > th {
      voicedMs += frameMs
      // The Bot had gone quiet before this voice began (not just the tail of a word): the gap's shorter bar.
      // Only between sentences: after the reply's first audio (before it, a reply keeps the 300 ms bar).
      let inGap = gapRule && sinceOutMs != nil && quietMs - voicedMs >= gapAfterMs + max(0, outputLatencyMs)
      if voicedMs >= (inGap ? gapSustainMs : sustainMs) {
        let detail = String(format: "voiced %d ms%@, mic %.1f dB > threshold %.1f dB (playback %@, coupling %.0f dB)", Int(voicedMs), inGap ? " in a gap between sentences" : "", db, th, playDb.map { String(format: "%.1f dB", $0) } ?? "silent", coupling)
        voicedMs = 0
        return .accept(detail)
      }
      return .none
    }
    // Quiet enough to be echo only: keep the coupling estimate current (slowly).
    if let p = playDb, db < th - marginDb { coupling = min(0, max(-60, coupling * 0.98 + (db - p) * 0.02)) }
    if db <= th - 6 && voicedMs > 0 {
      let run = voicedMs
      voicedMs = 0
      if run >= 60 { return .ignore(String(format: "short burst %d ms < %d ms (threshold %.1f dB)", Int(run), Int(sustainMs), th)) }
    }
    return .none
  }
}

// ---------- wake word: "Hey <Bot name>" (pure logic, self-tested) ----------
// The recognizer is the keyword spotter: an utterance only starts on voice activity, runs on-device,
// and what it hears is matched here and dropped. Only a match (the name and a confidence) leaves the
// process. The false-trigger guard: the name must come RIGHT after "hey", and the recognizer's own
// confidence for those words must reach the threshold.

/// Lower-case words with accents and punctuation removed ("Hey, Nóva!" → ["hey", "nova"]).
func wakeWords(_ s: String) -> [String] {
  let folded = s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
  let cleaned = String(folded.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " })
  return cleaned.split(separator: " ").map(String.init)
}

/// At most 50 names of 1–40 characters that have at least one word; duplicates dropped.
func cleanNames(_ raw: [String]) -> [String] {
  var seen = Set<String>(), out: [String] = []
  for n in raw {
    let t = n.trimmingCharacters(in: .whitespacesAndNewlines)
    let key = wakeWords(t).joined(separator: " ")
    guard !t.isEmpty, t.count <= 40, !key.isEmpty, !seen.contains(key) else { continue }
    seen.insert(key); out.append(t)
    if out.count >= 50 { break }
  }
  return out
}

func editDistance(_ a: String, _ b: String) -> Int {
  let x = Array(a), y = Array(b)
  if x.isEmpty { return y.count }
  if y.isEmpty { return x.count }
  var prev = Array(0...y.count), cur = Array(repeating: 0, count: y.count + 1)
  for i in 1...x.count {
    cur[0] = i
    for j in 1...y.count { cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1)) }
    swap(&prev, &cur)
  }
  return prev[y.count]
}

/// One heard word against one name word: equal, or one letter off for a word of 5+ letters (the
/// recognizer spells an unusual name slightly differently; short words must match exactly).
func wakeWordMatches(_ heard: String, _ name: String) -> Bool {
  heard == name || (name.count >= 5 && heard.count >= 4 && editDistance(heard, name) <= 1)
}

struct WakeHit: Equatable {
  let name: String; let start: Int; let count: Int
  /// Phase 2 (bug 213): "Hey Nova and Scout" — the other names, each straight after an "and", and
  /// where their words are (for their own confidence). At most 5 (a call holds 6).
  var also: [String] = []
  var alsoSpans: [Range<Int>] = []
}

/// "hey" immediately followed by all of a name's words. The longest name wins ("Nova Prime" over "Nova").
/// Phase 2 (bug 213): then "and <name>" as many times as it is said, for a group call in one phrase.
func wakeMatch(words: [String], names: [String]) -> WakeHit? {
  let ranked = names.map { ($0, wakeWords($0)) }.filter { !$0.1.isEmpty }.sorted { $0.1.count > $1.1.count }
  func nameAt(_ k: Int) -> (String, Int)? {
    for (name, nw) in ranked where k + nw.count <= words.count {
      if zip(words[k...].prefix(nw.count), nw).allSatisfy({ wakeWordMatches($0, $1) }) { return (name, nw.count) }
    }
    return nil
  }
  for i in words.indices where words[i] == "hey" {
    guard i + 1 < words.count, let (name, n) = nameAt(i + 1) else { continue }
    var hit = WakeHit(name: name, start: i, count: n + 1)
    var j = i + 1 + n
    while hit.also.count < 5, j + 1 < words.count, words[j] == "and", let (more, m) = nameAt(j + 1), more != name, !hit.also.contains(more) {
      hit.also.append(more)
      hit.alsoSpans.append((j + 1)..<(j + 1 + m))
      j += 1 + m
    }
    return hit
  }
  return nil
}
func wakeMatch(_ text: String, names: [String]) -> WakeHit? { wakeMatch(words: wakeWords(text), names: names) }

/// The recognizer's segments (word, confidence) → the match's confidence: the LOWEST of the matched
/// words ("hey" and the name). 0 when the segments don't contain the match. Bug 213: each extra name
/// ("… and Scout") gets its own, the lowest of its words.
func wakeConfidence(segments: [(String, Double)], names: [String]) -> (WakeHit, Double, [Double])? {
  var words: [String] = [], conf: [Double] = []
  for (s, c) in segments { for w in wakeWords(s) { words.append(w); conf.append(c) } }
  guard let hit = wakeMatch(words: words, names: names) else { return nil }
  return (hit, conf[hit.start..<(hit.start + hit.count)].min() ?? 0, hit.alsoSpans.map { conf[$0].min() ?? 0 })
}

func runWakeSelfTest() -> Never {
  var cases = 0
  var failures: [String] = []
  func check(_ name: String, _ ok: Bool) { cases += 1; if !ok { failures.append(name) } }
  let names = ["Nova", "Atlas", "Nova Prime", "Ellington", "Bo"]
  check("hey nova", wakeMatch("Hey Nova, are you there?", names: names)?.name == "Nova")
  check("comma and case", wakeMatch("hey, NOVA", names: names)?.name == "Nova")
  check("mid-sentence", wakeMatch("OK hey Atlas what's up", names: names)?.name == "Atlas")
  check("longest name wins", wakeMatch("Hey Nova Prime", names: names)?.name == "Nova Prime")
  check("name alone", wakeMatch("Nova is a nice name", names: names) == nil)
  check("hello is not hey", wakeMatch("Hello Nova", names: names) == nil)
  check("a word between", wakeMatch("Hey there Nova", names: names) == nil)
  check("hey at the end", wakeMatch("I said hey", names: names) == nil)
  check("unknown name", wakeMatch("Hey Siri", names: names) == nil)
  check("one letter off, long name", wakeMatch("Hey Elington", names: names)?.name == "Ellington")
  check("one letter off, short name is not enough", wakeMatch("Hey Nora", names: names) == nil)
  check("two-letter name exact", wakeMatch("hey bo", names: names)?.name == "Bo")
  check("two-letter name near miss", wakeMatch("hey go", names: names) == nil)
  check("accents", wakeMatch("Hey Nóva", names: names)?.name == "Nova")
  check("no names", wakeMatch("Hey Nova", names: []) == nil)
  check("clean names", cleanNames(["Nova", " nova ", "", "!!", String(repeating: "x", count: 41), "Atlas"]) == ["Nova", "Atlas"])
  let segs: [(String, Double)] = [("Hey", 0.92), ("Nova", 0.71), ("are", 0.4), ("you", 0.2)]
  check("confidence is the min of the matched words", wakeConfidence(segments: segs, names: names)?.1 == 0.71)
  check("confidence ignores other words", (wakeConfidence(segments: [("Hey", 0.9), ("Nova", 0.8), ("um", 0.05)], names: names)?.1 ?? 0) == 0.8)
  check("no confidence without the match", wakeConfidence(segments: [("Nova", 0.9)], names: names) == nil)
  // Phase 2 (bug 213): a group call in one phrase.
  check("hey nova and atlas", wakeMatch("Hey Nova and Atlas", names: names).map { [$0.name] + $0.also } == ["Nova", "Atlas"])
  check("hey nova and atlas and bo", wakeMatch("hey nova and atlas and bo, are you there", names: names).map { [$0.name] + $0.also } == ["Nova", "Atlas", "Bo"])
  check("and + longest name", wakeMatch("Hey Atlas and Nova Prime", names: names)?.also == ["Nova Prime"])
  check("'and' followed by no name: just the first", wakeMatch("Hey Nova and the others", names: names).map { [$0.name] + $0.also } == ["Nova"])
  check("the same name twice counts once", wakeMatch("Hey Nova and Nova", names: names)?.also == [])
  check("one name alone has no others", wakeMatch("Hey Nova", names: names)?.also == [])
  let group = wakeConfidence(segments: [("Hey", 0.9), ("Nova", 0.8), ("and", 0.6), ("Atlas", 0.25)], names: names)
  check("each extra name has its own confidence", group?.1 == 0.8 && group?.2 == [0.25])
  emit(["type": "self-test", "ok": failures.isEmpty, "cases": cases, "failures": failures])
  exit(failures.isEmpty ? 0 : 1)
}

func installedVoices() -> [VoiceInfo] {
  AVSpeechSynthesisVoice.speechVoices().map { v in
    var novelty = false, personal = false
    if #available(macOS 14.0, *) { novelty = v.voiceTraits.contains(.isNoveltyVoice); personal = v.voiceTraits.contains(.isPersonalVoice) }
    let q = v.quality == .premium ? 3 : v.quality == .enhanced ? 2 : 1
    return VoiceInfo(id: v.identifier, name: v.name, lang: v.language, quality: q, novelty: novelty, personal: personal)
  }
}
/// Never asks: personal voices are used only when the user already allowed it.
func personalVoicesAllowed() -> Bool {
  if #available(macOS 14.0, *) { return AVSpeechSynthesizer.personalVoiceAuthorizationStatus == .authorized }
  return false
}

func runListVoices() -> Never {
  let ranked = rankVoices(installedVoices(), locale: opt.locale, personalAllowed: personalVoicesAllowed())
  emit(["type": "voices", "voices": ranked.map { $0.json }])
  leave(0)
}

func runVoiceSelfTest() -> Never {
  var cases = 0
  var failures: [String] = []
  func check(_ name: String, _ ok: Bool) { cases += 1; if !ok { failures.append(name) } }
  let sam = VoiceInfo(id: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", lang: "en-US", quality: 1, novelty: false, personal: false)
  let samE = VoiceInfo(id: "com.apple.voice.enhanced.en-US.Samantha", name: "Samantha", lang: "en-US", quality: 2, novelty: false, personal: false)
  let zoe = VoiceInfo(id: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", lang: "en-US", quality: 3, novelty: false, personal: false)
  let eddy = VoiceInfo(id: "com.apple.eloquence.en-US.Eddy", name: "Eddy", lang: "en-US", quality: 1, novelty: false, personal: false)
  let bells = VoiceInfo(id: "com.apple.speech.synthesis.voice.Bells", name: "Bells", lang: "en-US", quality: 3, novelty: true, personal: false)
  let me = VoiceInfo(id: "personal.me", name: "Alex", lang: "en-US", quality: 3, novelty: false, personal: true)
  let dan = VoiceInfo(id: "com.apple.voice.enhanced.en-GB.Daniel", name: "Daniel", lang: "en-GB", quality: 2, novelty: false, personal: false)
  let fr = VoiceInfo(id: "com.apple.voice.premium.fr-FR.Audrey", name: "Audrey", lang: "fr-FR", quality: 3, novelty: false, personal: false)
  let all = [sam, eddy, bells, me, samE, dan, fr, zoe]
  check("premium first by default", chooseVoice(all, requested: nil, locale: "en_US", personalAllowed: true)?.id == zoe.id)
  check("enhanced beats compact", chooseVoice([sam, samE, eddy], requested: nil, locale: "en-US", personalAllowed: false)?.id == samE.id)
  check("compact Samantha beats Eloquence", chooseVoice([eddy, sam], requested: nil, locale: "en-US", personalAllowed: false)?.id == sam.id)
  check("a name means that name's best voice", chooseVoice(all, requested: "Samantha", locale: "en-US", personalAllowed: false)?.id == samE.id)
  check("an identifier is exact", chooseVoice(all, requested: sam.id, locale: "en-US", personalAllowed: false)?.id == sam.id)
  check("an unknown voice falls back to the best", chooseVoice(all, requested: "Nobody", locale: "en-US", personalAllowed: false)?.id == zoe.id)
  check("personal voice never by default", chooseVoice([me, sam], requested: nil, locale: "en-US", personalAllowed: true)?.id == sam.id)
  check("personal voice by id only when authorized", chooseVoice([me, sam], requested: me.id, locale: "en-US", personalAllowed: false)?.id == sam.id
    && chooseVoice([me, sam], requested: me.id, locale: "en-US", personalAllowed: true)?.id == me.id)
  let ranked = rankVoices(all, locale: "en-US", personalAllowed: false)
  check("ranked: language only, no novelty, no personal, best first", ranked.map { $0.id } == [zoe.id, samE.id, dan.id, sam.id, eddy.id])
  check("exact locale wins a tie", rankVoices([dan, samE], locale: "en-GB", personalAllowed: false).first?.id == dan.id)
  // End of turn.
  let b = 700.0
  check("sentence done: 560 ms", endOfTurn(text: "What time is it in Tokyo?", silenceMs: 600, sinceWordsMs: 600, baseMs: b, segmentEnded: false) == EndOfTurn(done: true, reason: "punctuation", windowMs: 560))
  check("no punctuation: 700 ms", !endOfTurn(text: "what time is it", silenceMs: 650, sinceWordsMs: 650, baseMs: b, segmentEnded: false).done
    && endOfTurn(text: "what time is it", silenceMs: 700, sinceWordsMs: 700, baseMs: b, segmentEnded: false).reason == "silence")
  check("trailing 'and' holds", !endOfTurn(text: "Book the flight and", silenceMs: 1200, sinceWordsMs: 1200, baseMs: b, segmentEnded: false).done
    && endOfTurn(text: "Book the flight and", silenceMs: 1800, sinceWordsMs: 1800, baseMs: b, segmentEnded: false).reason == "hold-trailing")
  check("trailing 'um,' holds", !endOfTurn(text: "So I was thinking, um,", silenceMs: 1000, sinceWordsMs: 1000, baseMs: b, segmentEnded: true).done)
  check("recognizer end of segment: 400 ms", endOfTurn(text: "turn the lights off", silenceMs: 420, sinceWordsMs: 420, baseMs: b, segmentEnded: true) == EndOfTurn(done: true, reason: "recognizer-final", windowMs: 400))
  // Plan item 2 (call-behaviour): "no new words" never ends a turn while the voice is still going — 42 of 57 such ends
  // on the user's calls came with under 200 ms of silence (Apple's words stall while the user talks on).
  check("no new words: a run-on whose words stall for 2 s is not cut while the voice goes on", !endOfTurn(text: "so I was thinking we could go to Paris", silenceMs: 80, sinceWordsMs: 2000, baseMs: b, segmentEnded: false).done)
  check("no new words: once the voice has paused (300 ms) it still ends", endOfTurn(text: "so I was thinking we could go to Paris", silenceMs: 320, sinceWordsMs: 2000, baseMs: b, segmentEnded: false) == EndOfTurn(done: true, reason: "no-new-words", windowMs: 1750))
  check("noise without new words still ends (5 s of voice with no words: a fan, the room)", !endOfTurn(text: "hello there", silenceMs: 0, sinceWordsMs: 4900, baseMs: b, segmentEnded: false).done
    && endOfTurn(text: "hello there", silenceMs: 0, sinceWordsMs: 5000, baseMs: b, segmentEnded: false).reason == "no-new-words")
  // Bug 142: the likely end of turn (a speculative start) — syntax + the recognizer's punctuation + a falling voice.
  check("likely end (5.8): the first one always may go", likelyAgain(sent: false, sentFor: "", count: 0, text: "Remind me to call the dentist"))
  check("likely end (5.8): not again for the same words (Apple only added the punctuation)", !likelyAgain(sent: true, sentFor: "Remind me to call the dentist", count: 1, text: "Remind me to call the dentist."))
  check("likely end (5.8): again once the user went on after a mid-thought pause", likelyAgain(sent: true, sentFor: "Remind me to call the dentist", count: 1, text: "Remind me to call the dentist on Friday morning."))
  check("likely end (5.8): at most \(LikelyEnds.max) an utterance", !likelyAgain(sent: true, sentFor: "a b", count: LikelyEnds.max, text: "a b c"))
  check("likely end: a finished question with a falling voice after 150 ms", likelyEnd(text: "What's on my calendar tomorrow?", silenceMs: 160, segmentEnded: false, tailFallDb: 6).likely)
  check("likely end: punctuation alone waits 250 ms", !likelyEnd(text: "Text Sam that I'm late.", silenceMs: 200, segmentEnded: false, tailFallDb: nil).likely
    && likelyEnd(text: "Text Sam that I'm late.", silenceMs: 260, segmentEnded: false, tailFallDb: nil).likely)
  check("likely end: a flat or rising voice is not a fall", !likelyEnd(text: "Is it raining?", silenceMs: 200, segmentEnded: false, tailFallDb: -2).likely)
  check("likely end: never on a trailing 'and' / comma / 'um'", !likelyEnd(text: "Book the flight and", silenceMs: 900, segmentEnded: true, tailFallDb: 8).likely
    && !likelyEnd(text: "So I was thinking,", silenceMs: 900, segmentEnded: true, tailFallDb: 8).likely)
  check("likely end: never on an unfinished clause ('I want to', 'can you')", !likelyEnd(text: "I want to.", silenceMs: 900, segmentEnded: true, tailFallDb: 8).likely
    && !likelyEnd(text: "Could you please.", silenceMs: 900, segmentEnded: true, tailFallDb: 8).likely)
  check("likely end: no punctuation and a level voice needs the recognizer's own segment end", !likelyEnd(text: "turn the lights off", silenceMs: 900, segmentEnded: false, tailFallDb: 1).likely
    && !likelyEnd(text: "turn the lights off", silenceMs: 900, segmentEnded: false, tailFallDb: nil).likely
    && likelyEnd(text: "turn the lights off", silenceMs: 310, segmentEnded: true, tailFallDb: nil).likely)
  // Bug 189: Apple leaves most finished statements unpunctuated until the final (52 of 103 turns on the
  // user's calls ended on bare silence), so a clause that is complete AND whose voice fell is likely done.
  check("likely end: no punctuation but a falling voice, after 300 ms", !likelyEnd(text: "turn the volume down a bit", silenceMs: 280, segmentEnded: false, tailFallDb: 6).likely
    && likelyEnd(text: "turn the volume down a bit", silenceMs: 310, segmentEnded: false, tailFallDb: 6).likely
    && !likelyEnd(text: "remind me to call the", silenceMs: 900, segmentEnded: false, tailFallDb: 8).likely)
  // Bug 189: the likely end judges the voice's silence once the words have settled — not from Apple's last partial,
  // which trails the last word by 300-500 ms (the end of turn keeps its clock: see turnSilence).
  check("turn silence: the voice's own, once the words have settled", turnSilence(voiceSilenceMs: 600, sinceWordsMs: 300, settleMs: 150) == 600)
  // Bug 185 x 189: a recognizer restart stitched onto the kept text moves the clock only for new words.
  do {
    let before = "I'll have it ready by then."
    let a = mergeAppleResult(committed: "", previous: before, next: "After")
    check("settle clock: a restart that brings a new word moves it",
          partialMovesClock(old: before, new: a.text, stitched: a.committed != ""))
    let b = mergeAppleResult(committed: a.committed, previous: "After", next: "I'll have it ready by then after")
    check("settle clock: a restart that re-reads the same words does not",
          b.committed != a.committed && !partialMovesClock(old: a.text, new: b.text, stitched: true))
    check("settle clock: a plain partial that only adds the closing \"?\" still moves it",
          partialMovesClock(old: "Can you do that", new: "Can you do that?", stitched: false))
  }
  check("turn silence: words still changing hold it to how long they've been still", turnSilence(voiceSilenceMs: 600, sinceWordsMs: 120, settleMs: 150) == 120
    && turnSilence(voiceSilenceMs: 80, sinceWordsMs: 900, settleMs: 150) == 80)
  check("likely end: one word is never enough", !likelyEnd(text: "Okay.", silenceMs: 900, segmentEnded: true, tailFallDb: 8).likely)
  // Plan item 16 (call-behaviour): after the Bot asked something, a short closed answer ends fast.
  check("short answer: after a question, \"Yes.\" ends at 400 ms", endOfTurn(text: "Yes.", silenceMs: 420, sinceWordsMs: 420, baseMs: b, segmentEnded: false, shortAnswer: true) == EndOfTurn(done: true, reason: "short-answer", windowMs: 400)
    && !endOfTurn(text: "Yes.", silenceMs: 420, sinceWordsMs: 420, baseMs: b, segmentEnded: false).done)
  check("short answer: \"Tuesday\" and \"no thanks\" too, with or without the full stop", endOfTurn(text: "Tuesday", silenceMs: 400, sinceWordsMs: 400, baseMs: b, segmentEnded: false, shortAnswer: true).done
    && endOfTurn(text: "No thanks.", silenceMs: 400, sinceWordsMs: 400, baseMs: b, segmentEnded: false, shortAnswer: true).done)
  check("short answer: never a trailing \"Yes, and\" or a longer turn", !endOfTurn(text: "Yes, and", silenceMs: 420, sinceWordsMs: 420, baseMs: b, segmentEnded: false, shortAnswer: true).done
    && !endOfTurn(text: "Yes,", silenceMs: 420, sinceWordsMs: 420, baseMs: b, segmentEnded: false, shortAnswer: true).done
    && !endOfTurn(text: "Yes book the hotel", silenceMs: 420, sinceWordsMs: 420, baseMs: b, segmentEnded: false, shortAnswer: true).done)
  let rising: [(Double, Double)] = (0..<40).map { (Double($0) * 50, -40 + Double($0) * 0.1) }
  let falling: [(Double, Double)] = (0..<40).map { (Double($0) * 50, $0 < 34 ? -30 : -40) }
  check("tail fall: a drop at the end is positive, a level voice is ~0", (tailFall(falling) ?? 0) > 6 && abs(tailFall(rising) ?? 99) < 3 && tailFall([(0, -30)]) == nil)
  // Barge-in.
  var g = BargeGate()
  var d: [BargeDecision] = []
  for i in 0..<12 { d.append(g.frame(db: -30, playDb: -20, sinceOutMs: Double(i) * 20, floorDb: -70, frameMs: 20)) } // 240 ms of loud echo in the holdoff
  check("holdoff: nothing counts, one log line", d.filter { $0 != .none }.count == 1 && d.contains { if case .ignore = $0 { return true }; return false })
  check("holdoff learns the echo coupling", g.coupling > -25)
  g = BargeGate()
  var accepted = false, ignored = false
  for i in 0..<10 { if case .accept = g.frame(db: -46, playDb: -20, sinceOutMs: 400 + Double(i) * 20, floorDb: -70, frameMs: 20) { accepted = true } } // echo-level
  check("echo at the expected level never barges in", !accepted)
  for i in 0..<10 { if case .ignore = g.frame(db: i < 8 ? -20 : -60, playDb: -20, sinceOutMs: 700 + Double(i) * 20, floorDb: -70, frameMs: 20) { ignored = true } } // 160 ms burst
  check("a short burst is ignored and logged", ignored)
  accepted = false
  for i in 0..<16 { if case .accept = g.frame(db: -18, playDb: -20, sinceOutMs: 1000 + Double(i) * 20, floorDb: -70, frameMs: 20) { accepted = true } }
  check("sustained speech above the echo barges in", accepted)
  check("threshold rises with the playback level", g.threshold(floorDb: -70, playDb: -10) > g.threshold(floorDb: -70, playDb: -30) && g.threshold(floorDb: -70, playDb: nil) == -38)
  // Plan item 26 (call-behaviour): in the silent gap between two sentences the user can take the floor sooner.
  g = BargeGate()
  var gapTook = false, gapFrames = 0
  for i in 0..<6 { _ = g.frame(db: -70, playDb: nil, sinceOutMs: 2_000 + Double(i) * 20, floorDb: -70, frameMs: 20) } // 120 ms: the Bot is between sentences
  for i in 0..<8 { gapFrames += 1; if case .accept = g.frame(db: -20, playDb: nil, sinceOutMs: 2_120 + Double(i) * 20, floorDb: -70, frameMs: 20) { gapTook = true; break } }
  check("gap: a 160 ms onset in the silence between sentences takes the floor", gapTook && gapFrames <= 8)
  g = BargeGate()
  var talkTook = false
  for i in 0..<8 { if case .accept = g.frame(db: -18, playDb: -20, sinceOutMs: 2_000 + Double(i) * 20, floorDb: -70, frameMs: 20) { talkTook = true } }
  check("gap: the same 160 ms onset while the Bot is audible does not (it needs 300 ms)", !talkTook)
  g = BargeGate()
  var edgeTook = false
  for i in 0..<2 { _ = g.frame(db: -70, playDb: nil, sinceOutMs: 2_000 + Double(i) * 20, floorDb: -70, frameMs: 20) } // only 40 ms of quiet
  for i in 0..<8 { if case .accept = g.frame(db: -20, playDb: nil, sinceOutMs: 2_040 + Double(i) * 20, floorDb: -70, frameMs: 20) { edgeTook = true } }
  check("gap: the tail of a word (under 100 ms of quiet before the onset) is not a gap", !edgeTook)
  // Review round 1: the route's latency pushes the gap out; no gap rule on Bluetooth / AirPlay or before first audio.
  func gapTakes(_ g0: BargeGate, quietFrames: Int, since: Double? = 2_000) -> Bool {
    var g = g0
    for i in 0..<quietFrames { _ = g.frame(db: -70, playDb: nil, sinceOutMs: since.map { $0 + Double(i) * 20 }, floorDb: -70, frameMs: 20) }
    for i in 0..<8 { if case .accept = g.frame(db: -20, playDb: nil, sinceOutMs: since.map { $0 + Double(quietFrames + i) * 20 }, floorDb: -70, frameMs: 20) { return true } }
    return false
  }
  var late = BargeGate(); late.outputLatencyMs = 200
  check("gap: 120 ms of quiet on a 200 ms-latency route is not yet a gap; 320 ms is", !gapTakes(late, quietFrames: 6) && gapTakes(late, quietFrames: 16))
  var bt = BargeGate(); bt.gapRule = false
  check("gap: never on Bluetooth / AirPlay", !gapTakes(bt, quietFrames: 20))
  check("gap: never before the reply's first audio (it keeps 300 ms)", !gapTakes(BargeGate(), quietFrames: 20, since: nil))
  var rs = BargeGate()
  for _ in 0..<20 { _ = rs.frame(db: -70, playDb: nil, sinceOutMs: 2_000, floorDb: -70, frameMs: 20) }
  rs.reset()
  check("gap: reset() forgets the quiet (the next reply starts from scratch)", !gapTakes(rs, quietFrames: 2))
  // Bug 107: Kokoro PCM over stdin, and the pause between sentences.
  let floats: [Float] = [0.5, -0.25, 1.0]
  let b64 = floats.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
  let decoded = pcmBuffer(base64: b64)
  check("pcm: 24 kHz mono float32", decoded?.format.sampleRate == 24000 && decoded?.format.channelCount == 1 && decoded?.frameLength == 3)
  check("pcm: little-endian samples round-trip", decoded.map { b in (0..<3).map { b.floatChannelData![0][$0] } } == floats)
  check("pcm: not base64 is rejected", pcmBuffer(base64: "not base64!") == nil)
  check("pcm: a partial sample is rejected", pcmBuffer(base64: Data([1, 2, 3, 4, 5, 6]).base64EncodedString()) == nil)
  check("pcm: empty is rejected", pcmBuffer(base64: "") == nil)
  // Bug 134: spatial seats.
  let c = panGains(0), l4 = panGains(-0.4), r4 = panGains(0.4)
  check("pan: centre is unity on both sides", c.left == 1 && c.right == 1)
  check("pan: ±0.4 is subtle and never louder than mono", r4.right == 1 && r4.left > 0.45 && r4.left < 0.6 && l4.left == 1 && abs(l4.right - r4.left) < 1e-6)
  check("pan: out of range and NaN are clamped", panGains(5).left < 0.001 && panGains(.nan).left == 1)
  let stereo48 = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
  let monoIn = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!, frameCapacity: 4)!
  monoIn.frameLength = 4
  for i in 0..<4 { monoIn.floatChannelData![0][i] = 0.5 }
  let sp = spread(monoIn, pan: 0.4, to: stereo48)
  check("spread: a seat right of centre", sp.map { $0.frameLength == 4 && $0.floatChannelData![1][2] == 0.5 && $0.floatChannelData![0][2] < 0.3 } == true)
  check("spread: refuses a mono target", spread(monoIn, pan: 0.4, to: monoIn.format) == nil)
  let fortyEight = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
  check("pause: 120 ms of silence at 48 kHz", silenceBuffer(ms: 120, format: fortyEight).map { $0.frameLength == 5760 && $0.floatChannelData![0][100] == 0 } == true)
  check("pause: none for 0 ms", silenceBuffer(ms: 0, format: fortyEight) == nil)
  let tenth = [Float](repeating: 0.1, count: 2400).withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
  let up = pcmBuffer(base64: tenth).flatMap { Converter(to: fortyEight).convert($0) }
  check("pcm: 24 kHz resamples to the engine's 48 kHz mono", up.map { $0.format.sampleRate == 48000 && $0.format.channelCount == 1 && $0.frameLength > 4000 } == true)
  emit(["type": "self-test", "ok": failures.isEmpty, "cases": cases, "failures": failures])
  exit(failures.isEmpty ? 0 : 1)
}

// ---------- text to speech ----------
/// Bug 107: Kokoro's PCM — mono float32 at 24 kHz, little-endian, base64 over stdin.
/// (A static, so it is ready even for modes that run before the top-level globals below are set.)
enum Kokoro { static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)! }
func pcmBuffer(base64: String) -> AVAudioPCMBuffer? {
  guard let d = Data(base64Encoded: base64), d.count >= 4, d.count % 4 == 0 else { return nil }
  let n = d.count / 4
  guard let buf = AVAudioPCMBuffer(pcmFormat: Kokoro.format, frameCapacity: AVAudioFrameCount(n)), let dst = buf.floatChannelData else { return nil }
  buf.frameLength = AVAudioFrameCount(n)
  d.withUnsafeBytes { raw in
    for i in 0..<n { dst[0][i] = Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self))) }
  }
  return buf
}
/// The pause after a sentence (bug 107), as silence in the player's own format.
func silenceBuffer(ms: Double, format: AVAudioFormat) -> AVAudioPCMBuffer? {
  let n = AVAudioFrameCount((format.sampleRate * ms / 1000).rounded())
  guard n > 0, let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { return nil }
  b.frameLength = n
  if let f = b.floatChannelData { for c in 0..<Int(format.channelCount) { f[c].update(repeating: 0, count: Int(n)) } }
  return b
}

/// Bug 134: a seat in the stereo field. The louder side is unity (never louder than the mono path, so
/// nothing clips), the other side falls off by the constant-power law: centre = (1, 1); ±0.4 ≈ −5.8 dB
/// on the far side, a subtle seat, not a hard pan.
func panGains(_ pan: Double) -> (left: Float, right: Float) {
  let p = min(max(pan.isFinite ? pan : 0, -1), 1)
  let a = (p + 1) * Double.pi / 4
  let l = cos(a), r = sin(a), m = max(l, r)
  return (Float(l / m), Float(r / m))
}

/// A mono buffer spread into `fmt` (2 channels) at a seat. nil when the formats don't fit.
func spread(_ mono: AVAudioPCMBuffer, pan: Double, to fmt: AVAudioFormat) -> AVAudioPCMBuffer? {
  guard fmt.channelCount == 2, mono.format.channelCount == 1, mono.format.sampleRate == fmt.sampleRate,
        let src = mono.floatChannelData, let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: mono.frameLength), let dst = out.floatChannelData else { return nil }
  out.frameLength = mono.frameLength
  let g = panGains(pan)
  for i in 0..<Int(mono.frameLength) { let x = src[0][i]; dst[0][i] = x * g.left; dst[1][i] = x * g.right }
  return out
}

// ---------- bug 213: spatial voices (real binaural seats on headphones) ----------
// A group call's voices sit on an arc in front of the listener that matches the avatar row. On
// headphones each Bot has its own mono player into an AVAudioEnvironmentNode rendering HRTFHQ (the
// real head-related filters: level AND time differences, pinna and head shadow); on speakers the old
// gentle level pan stays (time differences through speakers only comb-filter); a mono or unknown
// output keeps every voice centred. The direct player is still the path for a 1:1 call's voice, the
// pauses between lines of one reply stay on the player their line is on, and the barge-in fade covers
// every player at once.

/// How a call's voices are placed on the current output.
enum RouteMode: String { case headphones, speakers, centre }

/// What the helper knows about the output device (CoreAudio; there is no AVAudioSession on macOS).
struct OutputRoute: Equatable {
  let transport: String
  let channels: Int
  /// kAudioDevicePropertyDataSource of the output ('hdpn' = headphones on the jack, 'ispk' = internal speakers).
  let dataSource: UInt32?
  let name: String
  /// The same device also has a microphone (a headset).
  let hasInput: Bool
}

enum RouteWords {
  /// Checked first: things with speakers in them, whatever their transport.
  static let speakers = try! NSRegularExpression(pattern: #"speaker|soundlink|boom\b|megaboom|wonderboom|homepod|sonos|\becho\b|soundbar|display|monitor|\btv\b|television|jbl (flip|charge|go|clip|xtreme|pulse|boombox)|bose home|studio display"#, options: [.caseInsensitive])
  static let headphones = try! NSRegularExpression(pattern: #"head ?(phone|set)|earbud|earphone|airpods|\bbuds\b|beats|\bpods?\b|\bwh-|\bwf-|quietcomfort|\bqc ?\d|momentum|arctis|hyperx|jabra|sennheiser|shure|audio-technica|\bath-|bose|sony|nothing ear|plantronics|\bpoly\b|razer|corsair|steelseries|logitech g"#, options: [.caseInsensitive])
  /// USB audio interfaces: their outputs usually go to studio monitors.
  static let interfaces = try! NSRegularExpression(pattern: #"scarlett|focusrite|motu|apollo|universal audio|\bua\b|audient|ssl ?\d|presonus|behringer|rme|babyface|steinberg|\bur\d|zoom|tascam|roland|yamaha|mackie"#, options: [.caseInsensitive])
  static func has(_ r: NSRegularExpression, _ s: String) -> Bool { r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
}

/// Bug 213: headphones, speakers or centred, from the output device. `override` is --spatial-route
/// (headphones | speakers | off; anything else = auto). A mono output is always centred.
func routeMode(_ r: OutputRoute?, override: String? = nil) -> RouteMode {
  guard let r, r.channels >= 2 else { return .centre }
  switch override {
  case "headphones": return .headphones
  case "speakers": return .speakers
  case "off": return .centre
  default: break
  }
  let speakerName = RouteWords.has(RouteWords.speakers, r.name), phoneName = RouteWords.has(RouteWords.headphones, r.name)
  switch r.transport {
  case "built-in":
    // The Mac's own output: the jack reports headphones through its data source, or (MacBook Pros
    // since 2021) is a device of its own, "External Headphones".
    return r.dataSource == fourCC("hdpn") || (phoneName && !speakerName) ? .headphones : .speakers
  case "bluetooth", "bluetooth-le":
    // Almost every Bluetooth output on a Mac is headphones or earbuds; a speaker says so in its name.
    return speakerName ? .speakers : .headphones
  case "usb":
    if speakerName { return .speakers }
    if phoneName { return .headphones }
    // A USB device with its own microphone and a stereo output is a headset — unless it is an audio interface.
    return r.hasInput && !RouteWords.has(RouteWords.interfaces, r.name) ? .headphones : .speakers
  case "hdmi", "displayport", "airplay", "thunderbolt", "pci", "firewire":
    return phoneName && !speakerName ? .headphones : .speakers
  default:
    // Virtual, aggregate, unknown: nothing is known about where it plays, so every voice stays centred.
    return phoneName && !speakerName ? .headphones : .centre
  }
}

func caU32(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector, scope: AudioObjectPropertyScope) -> UInt32? {
  var addr = caAddr(sel, scope)
  var v: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &v) == noErr ? v : nil
}

/// The device's channel count in one direction (its stream configuration).
func deviceChannels(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int {
  var addr = caAddr(kAudioDevicePropertyStreamConfiguration, scope)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
  let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func outputRoute(_ d: AudioDev) -> OutputRoute {
  OutputRoute(transport: d.transport, channels: deviceChannels(d.id, kAudioObjectPropertyScopeOutput),
              dataSource: caU32(d.id, kAudioDevicePropertyDataSource, scope: kAudioObjectPropertyScopeOutput), name: d.name, hasInput: d.input)
}

/// Bug 213: a Bluetooth headset's own microphone switches it to the hands-free profile (mono,
/// narrowband) — every voice in one flat channel. When the call's output is that headset, the Mac's
/// built-in microphone is used instead so the output stays in stereo. Classic Bluetooth (AirPods and
/// most headsets) always drops to hands-free, so it is avoided up front; a Bluetooth LE device only
/// when it is seen to be mono. Nil = open the chosen / default microphone as usual (also when the Mac
/// has no built-in microphone, like a Mac mini).
/// Bug 213 (review): never when the user chose the microphone themselves, and never the Mac's own
/// microphone with the lid closed (it is off in clamshell mode).
func micKeepingStereo(input: AudioDev?, output: AudioDev?, outputChannels: Int, devices: [AudioDev], userChose: Bool = false, lidClosed: Bool = false) -> AudioDev? {
  guard !userChose, !lidClosed else { return nil }
  guard let input, let output, input.transport.hasPrefix("bluetooth"), output.transport.hasPrefix("bluetooth"),
        input.id == output.id || input.name == output.name else { return nil }
  guard input.transport == "bluetooth" || outputChannels < 2 else { return nil }
  // The Mac's own microphone — not the headphone jack's input ("External Microphone", listed on some
  // Macs even with nothing plugged in).
  let builtIn = devices.filter { $0.input && $0.transport == "built-in" && $0.id != input.id }
  let jack = { (d: AudioDev) in d.uid.localizedCaseInsensitiveContains("headphone") || d.name.lowercased().hasPrefix("external") }
  return builtIn.first { $0.uid == "BuiltInMicrophoneDevice" } ?? builtIn.first { !jack($0) }
}

/// Bug 213 (review): the MacBook's lid is closed (clamshell: its built-in microphone is off). IOKit's
/// power-management root domain says so; a Mac without a lid has no such property (false).
func lidClosed() -> Bool {
  let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
  guard root != 0 else { return false }
  defer { IOObjectRelease(root) }
  guard let v = IORegistryEntryCreateCFProperty(root, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() else { return false }
  return (v as? Bool) ?? false
}

enum SilentMic: Equatable { case wait, fine, fallBack }
/// The Mac's mic after the start: any sound above digital silence → fine; ~1.5 s of nothing at all
/// while the headset's own mic is there → back to it. (Room noise on a working mic is far above 1e-6.)
func silentMicVerdict(sinceMs: Double, peak: Float, headsetMicAvailable: Bool) -> SilentMic {
  if peak > 1e-6 { return .fine }
  if sinceMs < 1500 { return .wait }
  return headsetMicAvailable ? .fallBack : .fine
}

/// Bug 213 (review): how a call's audio path starts — each step only when the one above it fails:
/// as built → the headset's own mic (if the Mac's was swapped in) → mono → no echo cancellation.
enum StartStep: String, Equatable { case asBuilt = "as built", mono = "mono output", headsetMic = "headset microphone", noEchoCancellation = "no echo cancellation" }
func startLadder(stereo: Bool, voiceProcessing: Bool, micOverride: Bool) -> [StartStep] {
  var steps: [StartStep] = [.asBuilt]
  // The swapped mic is the newest, least proven part: undo it before giving up stereo.
  if voiceProcessing && micOverride { steps.append(.headsetMic) }
  if stereo { steps.append(.mono) }
  if voiceProcessing { steps.append(.noEchoCancellation) }
  return steps
}
/// Tries each step in order; the first that starts wins. Every failure is logged; the last one is thrown.
func climbLadder(_ steps: [StartStep], _ attempt: (StartStep) throws -> Void) throws -> StartStep {
  var last: Error?
  for step in steps {
    do { try attempt(step); return step } catch {
      log("audio path didn't start (\(step.rawValue)): \(error.localizedDescription)")
      last = error
    }
  }
  throw last ?? SourceError.noInputDevice
}

enum SeatMath {
  /// Everyone sits slightly in front, 1.2 m away, at ear height: close enough to feel like a table,
  /// far enough that no voice is "in your head". There is no distance attenuation (see SeatBank).
  static let distance = 1.2
  /// Speakers: the widest seat (±60°) gets today's gentle ±0.4 pan (bug 134); narrower seats less.
  static let maxPan = 0.4
  static func pan(azimuth az: Double) -> Double {
    guard az.isFinite else { return 0 }
    return min(max(maxPan * sin(az * .pi / 180) / sin(Double.pi / 3), -maxPan), maxPan)
  }
  /// A legacy `pan` (bug 134) as an azimuth, for a speak line that carries no azimuth.
  static func azimuth(pan p: Double) -> Double {
    guard p.isFinite else { return 0 }
    return asin(min(max(p / maxPan * sin(Double.pi / 3), -1), 1)) * 180 / .pi
  }
  static func position(azimuth az: Double) -> AVAudio3DPoint {
    let r = az * .pi / 180
    return AVAudio3DPoint(x: Float(distance * sin(r)), y: 0, z: Float(-distance * cos(r)))
  }
  /// HRTFHQ changes a voice's loudness with its angle (−1.9 to −3.1 LU against the same line played
  /// centred in both ears, which is the level every call has had). Measured on this Mac (macOS 27):
  /// three `say` voices, BS.1770 integrated loudness, 1.2 m, 10° steps; the voices agree within ±0.3 dB.
  /// (azimuth°, gain dB that brings the seat back to the centred level, output peak / input peak after that gain)
  static let hrtf: [(az: Double, db: Double, peak: Double)] = [
    (-90, 1.93, 1.47), (-80, 1.90, 1.44), (-70, 1.91, 1.41), (-60, 2.00, 1.37), (-50, 2.19, 1.34), (-40, 2.45, 1.31),
    (-30, 2.73, 1.26), (-20, 2.95, 1.20), (-10, 3.05, 1.11), (0, 3.05, 1.01), (10, 3.03, 1.10), (20, 2.87, 1.18),
    (30, 2.66, 1.25), (40, 2.36, 1.28), (50, 2.10, 1.34), (60, 1.97, 1.36), (70, 1.90, 1.40), (80, 1.89, 1.41), (90, 1.92, 1.41),
  ]
  static func hrtfEntry(_ az: Double) -> (db: Double, peak: Double) {
    let a = min(max(az.isFinite ? az : 0, -90), 90)
    let i = min(Int((a + 90) / 10), hrtf.count - 2)
    let lo = hrtf[i], hi = hrtf[i + 1], k = (a - lo.az) / 10
    return (lo.db + (hi.db - lo.db) * k, lo.peak + (hi.peak - lo.peak) * k)
  }
  /// The loudness-matching gain for a seat (linear).
  static func gain(azimuth az: Double) -> Float { Float(pow(10, hrtfEntry(az).db / 20)) }
  /// The highest input peak a seat takes at its full gain with its output kept under 0.9 (−0.9 dBFS; the
  /// table is the worst of three voices, so the margin covers a voice that peaks harder through the HRTF).
  static func peakRoom(azimuth az: Double) -> Float { Float(0.9 / hrtfEntry(az).peak) }
}

/// Bug 213: headphone seats. One mono player per Bot on the call (6 at most, the call's cap), all
/// wired into one environment node from the start of the call, so a Bot joining never changes the
/// graph. HRTFHQ per player; no reverb, no distance attenuation, no obstruction: a dry, close voice.
final class SeatBank {
  static let size = 6
  let env = AVAudioEnvironmentNode()
  let players: [AVAudioPlayerNode] = (0..<SeatBank.size).map { _ in AVAudioPlayerNode() }
  let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
  /// Wired into a (running or about to run) graph: only then may its players be played or stopped.
  private(set) var wired = false
  private var keys: [String?] = Array(repeating: nil, count: SeatBank.size)
  private var azimuths: [Double?] = Array(repeating: nil, count: SeatBank.size)
  private var used: [Double] = Array(repeating: 0, count: SeatBank.size)

  /// Players → environment node → `mixer` (stereo). Also used by the offline self-test, so it tests this wiring.
  func wire(into engine: AVAudioEngine, mixer: AVAudioNode, output: AVAudioFormat) {
    if env.engine == nil { engine.attach(env) }
    for p in players where p.engine == nil { engine.attach(p) }
    for p in players { engine.connect(p, to: env, format: format) }
    engine.connect(env, to: mixer, format: output)
    env.outputType = .headphones
    env.listenerPosition = AVAudio3DPoint(x: 0, y: 0, z: 0)
    env.listenerAngularOrientation = AVAudio3DAngularOrientation(yaw: 0, pitch: 0, roll: 0)
    env.reverbParameters.enable = false
    env.reverbParameters.level = -40
    // Every seat is at the same distance and nothing attenuates with it anyway: no level surprises.
    env.distanceAttenuationParameters.distanceAttenuationModel = .inverse
    env.distanceAttenuationParameters.referenceDistance = Float(SeatMath.distance * 2)
    env.distanceAttenuationParameters.maximumDistance = 100
    env.distanceAttenuationParameters.rolloffFactor = 0
    env.outputVolume = 1
    for (i, p) in players.enumerated() {
      p.renderingAlgorithm = .HRTFHQ
      p.sourceMode = .pointSource
      p.reverbBlend = 0
      p.obstruction = 0
      p.occlusion = 0
      p.position = SeatMath.position(azimuth: azimuths[i] ?? 0)
    }
    wired = true
  }

  /// Out of the graph (a mono output): the players can't be played until wired again.
  func unwire(from engine: AVAudioEngine) {
    guard env.engine != nil else { wired = false; return }
    for p in players where p.engine != nil { engine.disconnectNodeOutput(p) }
    engine.disconnectNodeOutput(env)
    wired = false
  }

  /// The player for a Bot's seat (the same one for the whole call), moved to `azimuth` when the call's
  /// arc has changed since it last spoke. A new Bot takes a free player, else the least recently used
  /// one that is quiet — never one still playing someone else's line (nil then: no seat free).
  func player(for key: String, azimuth: Double, inUse: (AVAudioPlayerNode) -> Bool = { _ in false }) -> AVAudioPlayerNode? {
    let quiet = used.indices.filter { keys[$0] == nil || !inUse(players[$0]) }
    guard let i = keys.firstIndex(of: key) ?? keys.firstIndex(of: nil) ?? quiet.min(by: { used[$0] < used[$1] }) else { return nil }
    keys[i] = key
    used[i] = nowMs()
    if azimuths[i] != azimuth {
      azimuths[i] = azimuth
      players[i].position = SeatMath.position(azimuth: azimuth)
    }
    return players[i]
  }

  func playAll() { guard wired else { return }; for p in players where !p.isPlaying { p.play() } }

  /// Frees the seats of Bots no longer on the call (a Bot that left), unless still playing.
  func release(except keep: Set<String>, inUse: (AVAudioPlayerNode) -> Bool) {
    for i in keys.indices { if let k = keys[i], !keep.contains(k), !inUse(players[i]) { keys[i] = nil } }
  }

  /// Which Bot a player belongs to (the self-test checks seats are freed and never shared).
  func owner(of p: AVAudioPlayerNode) -> String? { players.firstIndex { $0 === p }.flatMap { keys[$0] } }
}

final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
  /// One queued piece of a reply (bug 106: a streamed reply arrives sentence by sentence, and each
  /// sentence plays straight after the one before — the synthesizer and the player are both FIFOs).
  /// Bug 107: a piece's audio comes from Apple's synthesizer or, for a PCM line, from Kokoro via stdin.
  private final class Item {
    let id: String; let gen: Int; let at: Double
    var pending = 0, synthDone = false, framesOut = 0.0, doneAt = 0.0, firstOut = false, delegateDoneAt = 0.0
    /// Bug 219: where this line's last scheduled audio ends on the playback timeline (nowMs() time; 0 = none yet).
    var endsAt = 0.0
    /// Review round 1: the wall clock and the player's render position when its first buffer was scheduled (reset by
    /// a restart), so a render that stalled mid-line moves the line's end instead of ending it early.
    var anchorWall = 0.0
    var anchorRender: Double?
    weak var anchorNode: AVAudioPlayerNode?
    /// Waiting for its turn at the synthesizer (nil once handed over).
    var utterance: AVSpeechUtterance?
    var writing = false
    /// A PCM (Kokoro) line, and what its Apple fallback needs.
    var pcm = false
    var text = "", voice: String? = nil, rate: Double? = nil, lang: String? = nil
    var pauseMs = 0.0
    /// Bug 180: the format this line's audio arrives in, so its pause can follow it through the converter.
    var inFormat: AVAudioFormat?
    /// Bug 134: the line's seat in a group call (0 = centre; only heard while the output is stereo).
    var pan = 0.0
    /// Bug 213: the seat as an angle (nil = a 1:1 call's voice: centred on the direct player), and
    /// whose seat it is (one headphone player per Bot).
    var azimuth: Double?
    var seat: String?
    /// Bug 213: this line's loudness-matching gain on a headphone seat; only ever lowered (never
    /// raised) mid-line, when a hot chunk would otherwise reach full scale after the HRTF.
    var seatGain: Float?
    var lastDataAt = 0.0
    /// Audio that arrived while an earlier line was still being synthesized (played once it's done).
    var stash: [(buf: AVAudioPCMBuffer, silent: Bool)] = []
    init(id: String, gen: Int, at: Double) { self.id = id; self.gen = gen; self.at = at }
  }
  private let synth = AVSpeechSynthesizer()
  private let player: AVAudioPlayerNode?
  /// The player's format: 48 kHz mono, or stereo while spatial voices are on (bug 134).
  private var format: AVAudioFormat?
  /// Speech is always converted to 48 kHz MONO first; a stereo output then spreads it to the line's seat.
  private let converter: Converter?
  private var gen = 0
  private var items: [Item] = []
  private var byUtterance: [ObjectIdentifier: Item] = [:]
  var currentId: String? { items.first?.id }
  var isSpeaking: Bool { !items.isEmpty }
  /// nowMs() when the current reply's first audio went out (0 = nothing audible yet); barge-in's holdoff runs from here.
  private(set) var audibleSince = 0.0
  /// What the player is playing, for barge-in's echo estimate: (start, end, dB) in nowMs() time.
  private var outLevels: [(start: Double, end: Double, db: Double)] = []
  private var playheadEnd = 0.0
  /// Called when a reply finishes or is cut off (the speaker test exits on it).
  var onEnd: ((String) -> Void)?

  /// AVAudioPlayerNode.play() raises (uncatchable) when its engine is stopped — e.g. between a configuration
  /// change and the restart — so every play() checks first; the restart resumes the player.
  private let engineRunning: () -> Bool

  /// Bug 141: every buffer handed to the player is kept until it has PLAYED. Stopping an engine (a
  /// configuration change restarts it, often ~1 s into a call) flushes the player's queue, and its
  /// completion handlers fire as if the audio had been heard: the greeting was logged "spoke" and
  /// never came out. Now a restart replays whatever hadn't played (a partly played buffer from its
  /// start: at most one 0.5 s chunk heard twice), and nothing is scheduled while the path is in flux.
  private final class Sched {
    let item: Item; let mono: AVAudioPCMBuffer; let silent: Bool; let secs: Double; let db: Double
    /// The path epoch it was scheduled in (-1 = waiting); done = it really played (set on the audio thread).
    var epoch = -1, done = false
    /// Bug 213: the player it went to (the direct one, or a Bot's headphone seat).
    var node: AVAudioPlayerNode?
    init(item: Item, mono: AVAudioPCMBuffer, silent: Bool, secs: Double, db: Double) { self.item = item; self.mono = mono; self.silent = silent; self.secs = secs; self.db = db }
  }
  private var scheds: [Sched] = []
  /// True while the audio path is starting or restarting: buffers wait in `scheds`.
  private(set) var holding: Bool
  private var epoch = 0
  /// The epoch the completion handlers compare against (they run on the audio thread).
  private var lockedEpoch = 0
  private let doneLock = NSLock()
  private var settleToken = 0
  /// When a buffer counts as played: heard (a device), or rendered (the offline self-test has no device).
  private let playedBack: AVAudioPlayerNodeCompletionCallbackType

  /// The engine is about to stop (configuration change, device change, spatial rebuild): hold, and
  /// forget what the player has queued — it will be scheduled again once the path is back.
  func pathStopping() {
    guard player != nil else { return }
    for it in items { it.anchorWall = 0; it.anchorRender = nil } // a restart re-anchors each line when it is scheduled again
    endFade()
    holding = true
    settleToken += 1
    doneLock.lock(); epoch += 1; lockedEpoch = epoch; doneLock.unlock()
    for p in nodes { p.stop() }
    resetSwitch()
    outLevels = []
    playheadEnd = 0
  }

  // ---- bug 213: several players, one voice at a time ----
  /// The headphone seats (nil or unwired = every line on the direct player) and how lines are placed.
  private var seats: SeatBank?
  private(set) var mode: RouteMode = .centre
  /// Every player speech can be on: the direct one, and the headphone seats while they are wired.
  private var nodes: [AVAudioPlayerNode] {
    var n: [AVAudioPlayerNode] = player.map { [$0] } ?? []
    if let s = seats, s.wired { n += s.players }
    return n
  }
  /// The player the last buffer went to. A buffer for ANOTHER player waits (in order, with everything
  /// after it) until this one has consumed what it has, so two Bots never overlap: a one-frame marker
  /// on the old player calls back the moment it is pulled into the render, and the waiting buffers go
  /// out then — within one render cycle, well inside the pause that ends every line.
  private var lastNode: AVAudioPlayerNode?
  private var switchQueue: [Sched] = []
  private var switchMarker = false
  private var switchToken = 0

  private func resetSwitch() {
    switchToken += 1
    switchMarker = false
    switchQueue = []
    lastNode = nil
  }

  /// Bug 213: the output was (re)built or its route changed: where lines play from now on. Lines
  /// already on a player finish there; nothing already scheduled moves.
  func setOutput(format f: AVAudioFormat, seats s: SeatBank?, mode m: RouteMode) {
    if format?.channelCount != f.channelCount || mode != m { log("speech output: \(f.channelCount == 2 ? "stereo" : "mono"), voices \(m.rawValue)\(m == .headphones && s?.wired == true ? " (HRTF seats)" : "")") }
    format = f
    seats = s
    mode = f.channelCount == 2 ? m : .centre
  }

  /// Where a buffer plays and what exactly is handed over: a headphone seat takes the mono line with
  /// its loudness-matching gain; the direct player takes it mono, or stereo spread to the speakers'
  /// pan (centred for a 1:1 call and for a centred route).
  private func target(_ s: Sched) -> (AVAudioPlayerNode, AVAudioPCMBuffer)? {
    guard let player else { return nil }
    let it = s.item
    if mode == .headphones, let seats, seats.wired, let az = it.azimuth {
      if let p = seats.player(for: it.seat ?? "az:\(az)", azimuth: az, inUse: { busy($0) }) {
        if s.silent { return silenceBuffer(ms: s.secs * 1000, format: seats.format).map { (p, $0) } }
        return gained(s.mono, it, azimuth: az).map { (p, $0) }
      }
      log("\(it.id): every headphone seat is busy; this line plays centred on the direct player")
    }
    guard let f = format, f.channelCount == 2 else { return (player, s.mono) }
    let pan = mode == .speakers ? (it.azimuth.map { SeatMath.pan(azimuth: $0) } ?? it.pan) : 0
    let out = s.silent ? silenceBuffer(ms: s.secs * 1000, format: f) : spread(s.mono, pan: pan, to: f)
    return out.map { (player, $0) }
  }

  /// A seat's copy of a mono buffer at the seat's loudness-matching gain. A chunk loud enough to come
  /// near full scale after the HRTF lowers the line's gain for the rest of it (never raises it again):
  /// the first chunk of a line simply starts lower; a later one steps down over 1.3 ms. Kokoro's voices
  /// peak far below this (RMS ~0.06), so in practice it is a guard, not a limiter.
  private func gained(_ mono: AVAudioPCMBuffer, _ it: Item, azimuth az: Double) -> AVAudioPCMBuffer? {
    guard let src = mono.floatChannelData, let out = AVAudioPCMBuffer(pcmFormat: mono.format, frameCapacity: mono.frameLength), let dst = out.floatChannelData else { return nil }
    let n = Int(mono.frameLength)
    out.frameLength = mono.frameLength
    var peak: Float = 0
    for i in 0..<n { peak = max(peak, abs(src[0][i])) }
    let full = SeatMath.gain(azimuth: az)
    let allowed = peak > 0 ? full * min(1, SeatMath.peakRoom(azimuth: az) / peak) : full
    let from = it.seatGain ?? allowed
    let to = min(from, allowed)
    if to < full - 1e-4 && to < (it.seatGain ?? full) - 1e-4 { log("\(it.id): seat gain \(String(format: "%.2f", 20 * log10(Double(full)))) → \(String(format: "%.2f", 20 * log10(Double(to)))) dB (a loud chunk, peak \(String(format: "%.2f", peak)))") }
    it.seatGain = to
    let ramp = min(n, 64)
    for i in 0..<n { dst[0][i] = src[0][i] * (i < ramp && ramp > 1 ? from + (to - from) * Float(i) / Float(ramp - 1) : to) }
    return out
  }

  /// `done` is set on the audio thread (under doneLock), so it is read under it too.
  private func busy(_ p: AVAudioPlayerNode) -> Bool {
    doneLock.lock(); defer { doneLock.unlock() }
    return scheds.contains { $0.node === p && $0.epoch == epoch && !$0.done }
  }

  /// A one-frame marker on the old player: when it is consumed, everything scheduled there before it
  /// has gone into the render, and the next player may start.
  private func placeMarker(on p: AVAudioPlayerNode) {
    guard !switchMarker, let f = p.outputFormat(forBus: 0).channelCount > 0 ? AVAudioFormat(standardFormatWithSampleRate: 48000, channels: p.outputFormat(forBus: 0).channelCount) : nil,
          let b = silenceBuffer(ms: 1000.0 / 48000.0, format: f) else { return }
    switchMarker = true
    let token = switchToken
    p.scheduleBuffer(b, completionCallbackType: .dataConsumed) { [weak self] _ in
      q.async { self?.switchReady(token, "consumed") }
    }
    if !p.isPlaying && engineRunning() { p.play() }
    // Bug 213 (review): a marker that is never consumed (the player stalled, the engine stopped under
    // it) must not hold every later line: once the old player's audio should long have played, go anyway.
    let due = max(0, playheadEnd - nowMs()) + 2000
    q.asyncAfter(deadline: .now() + .milliseconds(Int(due))) { [weak self] in self?.switchReady(token, "timed out") }
  }

  /// The old player has consumed its audio (or its marker timed out): the waiting buffers go out, in order.
  private func switchReady(_ token: Int, _ why: String) {
    guard switchToken == token, switchMarker else { return }
    if why != "consumed" { log("switch marker \(why); playing the next line anyway") }
    switchToken += 1
    switchMarker = false
    lastNode = nil
    let waiting = switchQueue
    switchQueue = []
    for s in waiting where s.item.gen == gen && scheds.contains(where: { $0 === s }) { schedule(s) }
  }

  /// Bug 213 (review): the Bots still on the call. A seat whose Bot left is freed (once it is quiet).
  func keepSeats(_ keys: [String]) {
    guard let seats else { return }
    seats.release(except: Set(keys)) { p in busy(p) }
  }

  /// The engine started. Playback resumes once it has stayed up for `settleMs` (voice processing
  /// usually posts one more configuration change right after its first start).
  func pathStarted(settleMs: Double) {
    guard holding else { return }
    settleToken += 1
    let token = settleToken
    if settleMs <= 0 { release(); return }
    // An engine that reports not running yet is given more time, but speech is never held for good.
    func wait(_ tries: Int) {
      q.asyncAfter(deadline: .now() + .milliseconds(Int(settleMs))) { [weak self] in
        guard let self, self.settleToken == token, self.holding else { return }
        if !self.engineRunning() && tries < 8 { wait(tries + 1); return }
        self.release()
      }
    }
    wait(0)
  }

  private func release() {
    holding = false
    let now = nowMs()
    let waiting = scheds.filter { !$0.done && $0.item.gen == gen }
    if !waiting.isEmpty { log("audio path settled; playing \(waiting.count) held buffer(s)") }
    // The overrun deadline counts from when the audio could really start.
    for it in items where it.synthDone { it.doneAt = max(it.doneAt, now) }
    for s in waiting { schedule(s) }
  }

  init(player: AVAudioPlayerNode?, format: AVAudioFormat?, engineRunning: @escaping () -> Bool = { true }, holdUntilStarted: Bool = false, playedBack: AVAudioPlayerNodeCompletionCallbackType = .dataPlayedBack) {
    self.playedBack = playedBack
    self.engineRunning = engineRunning
    self.player = player
    self.format = format
    holding = holdUntilStarted && player != nil
    converter = format.map { Converter(to: AVAudioFormat(standardFormatWithSampleRate: $0.sampleRate, channels: 1)!, slice: 4096) }
    super.init()
    synth.delegate = self
  }

  /// Bug 134: the audio path was rebuilt: buffers from now on are made for this format (the seats and
  /// the route as they were; see setOutput).
  func setOutputFormat(_ f: AVAudioFormat) { setOutput(format: f, seats: seats, mode: mode) }

  private static var installed: [VoiceInfo]?
  /// Bug 106: the best installed voice (premium > enhanced > compact), or the one asked for: the line's
  /// own voice (each Bot has one), else Settings → Voice (--voice). A name means its best-quality voice.
  static func pickVoice(name: String?, lang: String?) -> (voice: AVSpeechSynthesisVoice?, info: VoiceInfo?) {
    if installed == nil { installed = installedVoices() }
    let language = normLocale((lang?.isEmpty == false) ? lang! : opt.locale)
    // The voice the app asks for per line (a Bot's own voice in a call) wins; else Settings → Voice.
    let requested = ((name?.isEmpty == false) ? name : nil) ?? opt.voice
    if let v = chooseVoice(installed!, requested: requested, locale: language, personalAllowed: personalVoicesAllowed()), let av = AVSpeechSynthesisVoice(identifier: v.id) { return (av, v) }
    return (AVSpeechSynthesisVoice(language: language), nil)
  }

  /// Load the voice before the first reply (a cold voice takes ~0.5–0.7 s to its first buffer).
  func prewarm() {
    let u = AVSpeechUtterance(string: "Okay.")
    let pick = Speaker.pickVoice(name: nil, lang: nil)
    u.voice = pick.voice
    let t = nowMs()
    log("voice \(pick.info?.name ?? pick.voice?.name ?? "default") (\(pick.info?.qualityName ?? "?"), \(pick.info?.id ?? "-")); warming up")
    DispatchQueue.main.async {
      var first = true
      self.synth.write(u) { _ in if first { first = false; log("voice warm after \(Int(nowMs() - t)) ms") } }
    }
  }

  private func appleUtterance(_ it: Item) -> (AVSpeechUtterance, VoiceInfo?) {
    let u = AVSpeechUtterance(string: it.text)
    let pick = Speaker.pickVoice(name: it.voice, lang: it.lang)
    u.voice = pick.voice
    // Natural defaults: Apple's default rate (what Spoken Content uses at 1x), neutral pitch, full
    // volume, no pause before or after (queued sentences run on without a gap; bug 107's pause is ours).
    let r = AVSpeechUtteranceDefaultSpeechRate * Float(it.rate ?? 1)
    u.rate = min(max(r, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    u.pitchMultiplier = 1.0
    u.volume = 1.0
    u.preUtteranceDelay = 0
    u.postUtteranceDelay = 0
    byUtterance[ObjectIdentifier(u)] = it
    return (u, pick.info)
  }

  /// `queue`: play after what is already playing (the next sentence of the same reply); otherwise
  /// anything playing is cut off first (a new reply). `engine == "pcm"`: the audio arrives as Kokoro PCM.
  func speak(id: String, text: String, voice: String?, rate: Double?, lang: String?, queue: Bool = false, engine: String? = nil, pauseMs: Double = 0, pan: Double = 0, azimuth: Double? = nil, seat: String? = nil) {
    if isSpeaking && !queue { stop(interrupted: true) }
    if items.isEmpty { gen += 1; audibleSince = 0 }
    let item = Item(id: id, gen: gen, at: nowMs())
    item.text = text; item.voice = voice; item.rate = rate; item.lang = lang
    item.pauseMs = min(max(pauseMs, 0), 1000)
    item.pan = min(max(pan.isFinite ? pan : 0, -1), 1)
    // Bug 213: a seat angle (a group call); a legacy pan alone is turned into one.
    if let a = azimuth, a.isFinite { item.azimuth = min(max(a, -90), 90) } else if item.pan != 0 { item.azimuth = SeatMath.azimuth(pan: item.pan) }
    item.seat = seat.map { String($0.prefix(80)) }
    items.append(item)
    if engine == "pcm" {
      // Receiving from Kokoro counts as synthesizing: Apple lines queued behind it wait their turn.
      item.pcm = true
      item.writing = true
      item.lastDataAt = nowMs()
      log("speak \(id): \(text.count) chars, engine=pcm\(queue ? " queued" : "")")
      emit(["type": "speak-start", "id": id, "voice": "kokoro"])
      return
    }
    let (u, info) = appleUtterance(item)
    log("speak \(id): \(text.count) chars, voice=\(u.voice?.name ?? "default") quality=\(info?.qualityName ?? "?")\(queue ? " queued" : "")")
    emit(["type": "speak-start", "id": id, "voice": u.voice?.name ?? ""])
    item.utterance = u
    writeNext()
  }

  private func pcmItem(_ id: String) -> Item? { items.first { $0.id == id && $0.pcm && !$0.synthDone && $0.gen == gen } }

  /// Bug 107: one chunk of a PCM line. A chunk for a line that was cut off (hush, barge-in) is dropped.
  func pcm(id: String, base64: String) {
    guard let it = pcmItem(id) else { return }
    guard let buf = pcmBuffer(base64: base64) else { log("bad pcm chunk for \(id)"); return }
    it.lastDataAt = nowMs()
    onSynth(it, buf)
  }

  /// Bug 180: one chunk of a PCM line in any format (the playback self-test drives Apple's 22.05 kHz).
  func pcm(id: String, buffer: AVAudioPCMBuffer) {
    guard let it = pcmItem(id) else { return }
    it.lastDataAt = nowMs()
    onSynth(it, buffer)
  }

  func pcmEnd(id: String) {
    guard let it = pcmItem(id) else { return }
    synthesized(it)
  }

  /// Kokoro couldn't say this line: Apple's voice says it, unless some of it has already played.
  func pcmFail(id: String, why: String = "kokoro failed") {
    guard let it = pcmItem(id) else { return }
    if it.framesOut > 0 || !it.stash.isEmpty { log("\(id): \(why) part-way; ending the line"); synthesized(it); return }
    log("\(id): \(why); falling back to the Apple voice")
    it.pcm = false
    it.writing = false
    it.utterance = appleUtterance(it).0
    writeNext()
  }

  /// write() is NOT a queue: a second write() cuts off the one in progress. So each sentence is
  /// handed to the synthesizer only once the one before it is fully synthesized — still well before
  /// it has finished PLAYING (synthesis runs many times faster than real time), so playback is gapless.
  private func writeNext() {
    guard let it = items.first(where: { $0.utterance != nil }), !items.contains(where: { $0.writing && !$0.synthDone }) else { return }
    guard let u = it.utterance else { return }
    it.utterance = nil
    it.writing = true
    DispatchQueue.main.async {
      self.synth.write(u) { [weak self] buffer in
        guard let self, let pcm = buffer as? AVAudioPCMBuffer else { return }
        q.async { self.onSynth(it, pcm) }
      }
    }
  }

  /// Every line ahead of this one has all its audio: this one's may go to the player now.
  private func canPlay(_ it: Item) -> Bool {
    for x in items { if x === it { return true }; if !x.synthDone { return false } }
    return false
  }

  private func onSynth(_ it: Item, _ pcm: AVAudioPCMBuffer) {
    guard it.gen == gen, items.contains(where: { $0 === it }) else { return }
    if pcm.frameLength == 0 { synthesized(it); return }
    it.inFormat = pcm.format
    if !canPlay(it) { it.stash.append((pcm, false)); return }
    play(it, pcm)
  }

  private func play(_ it: Item, _ pcm: AVAudioPCMBuffer, silent: Bool = false) {
    let secs = Double(pcm.frameLength) / pcm.format.sampleRate
    it.framesOut += secs
    let n = Int(pcm.frameLength)
    var sum = 0.0
    if let f = pcm.floatChannelData { for k in 0..<n { sum += Double(f[0][k] * f[0][k]) } }
    else if let i16 = pcm.int16ChannelData { for k in 0..<n { let x = Double(i16[0][k]) / 32768; sum += x * x } }
    let db = max(-100, 20 * log10(sqrt(sum / Double(max(n, 1))) + 1e-10))
    // The pause is already 48 kHz mono; speech goes through the converter (24 kHz Kokoro or Apple's
    // format → the engine's 48 kHz mono, the format voice processing needs — bugs 103/104).
    guard player != nil, let mono = silent ? pcm : converter?.convert(pcm) else {
      if player != nil { log("\(it.id): the converter returned nothing for \(pcm.frameLength) frames at \(Int(pcm.format.sampleRate)) Hz; dropped") }
      // No player (a file source): nothing is heard, the line still starts and ends in order.
      if !it.firstOut && !silent {
        it.firstOut = true
        if audibleSince == 0 { audibleSince = nowMs() }
        log("first audio out \(it.id) after \(Int(nowMs() - it.at)) ms\(it.pcm ? " (kokoro)" : "")")
        emit(["type": "speak-audio", "id": it.id])
      }
      return
    }
    let s = Sched(item: it, mono: mono, silent: silent, secs: secs, db: db)
    it.pending += 1
    scheds.append(s)
    if !holding { schedule(s) }
  }

  /// Hands one buffer to the player (now, or again after a restart).
  private func schedule(_ s: Sched) {
    guard player != nil else { return }
    endFade() // bug 188: a new line never plays under the old one's fade (or at its volume)
    // Bug 213: one voice at a time across players — a buffer for another player waits its turn.
    if switchMarker || !switchQueue.isEmpty { switchQueue.append(s); return }
    guard let (node, out) = target(s) else {
      log("dropped a buffer that has no player to go to")
      s.done = true
      finished(s)
      return
    }
    if let last = lastNode, last !== node, busy(last) {
      switchQueue.append(s)
      placeMarker(on: last)
      if switchMarker { return }
      switchQueue.removeLast() // no marker could be placed: play it now rather than never
    }
    commit(s, node, out)
  }

  private func commit(_ s: Sched, _ player: AVAudioPlayerNode, _ out: AVAudioPCMBuffer) {
    let it = s.item
    // Level of this buffer, placed on the playback timeline (the player is a FIFO).
    let now = nowMs()
    let start = max(now, playheadEnd)
    playheadEnd = start + s.secs * 1000
    it.endsAt = playheadEnd
    // Not rendered yet at all (a fresh engine): its render clock starts at 0.
    if it.anchorWall == 0 { it.anchorWall = now; it.anchorNode = player; it.anchorRender = renderMs(player) ?? 0 }
    outLevels.append((start, playheadEnd, s.db))
    outLevels.removeAll { $0.end < now - 1000 }
    if !it.firstOut && !s.silent {
      it.firstOut = true
      if audibleSince == 0 { audibleSince = start }
      log("first audio out \(it.id) after \(Int(now - it.at)) ms\(it.pcm ? " (kokoro)" : "")")
      emit(["type": "speak-audio", "id": it.id])
    }
    // Bug 134 / 210: the line at its Bot's seat. Made from the mono buffer at the moment it is
    // scheduled (target()), so a line held across a rebuild or a route change fits its player.
    let want = player.outputFormat(forBus: 0).channelCount
    guard want == 0 || out.format.channelCount == want else {
      log("dropped a buffer made for the old audio path")
      s.done = true
      finished(s)
      return
    }
    s.epoch = epoch
    s.node = player
    lastNode = player
    player.scheduleBuffer(out, completionCallbackType: playedBack) { [weak self] _ in
      guard let self else { return }
      // A flush by a restart also calls this: only a buffer of the current path epoch has played.
      self.doneLock.lock()
      let played = s.epoch == self.lockedEpoch
      if played { s.done = true }
      self.doneLock.unlock()
      guard played else { return }
      q.async { self.finished(s) }
    }
    if !player.isPlaying && engineRunning() { player.play() }
  }

  private func finished(_ s: Sched) {
    guard let i = scheds.firstIndex(where: { $0 === s }) else { return }
    scheds.remove(at: i)
    guard s.item.gen == gen else { return }
    s.item.pending -= 1
    maybeFinish()
  }

  /// The level (dB) of the reply audio playing at `t`, nil when nothing is playing.
  func playbackDb(at t: Double) -> Double? {
    outLevels.first(where: { $0.start <= t && t < $0.end })?.db
  }

  private func synthesized(_ it: Item) {
    guard it.gen == gen, !it.synthDone else { return }
    // Anything it stashed plays first (its turn has come: it can only finish in order).
    // Bug 107: a small pause after the sentence, so a reply's lines don't run into each other.
    // Bug 180: made at the line's OWN rate and sent through the converter like its speech, so it
    // plays after ALL of the line — the converter always keeps its filter's last ~0.7 ms back, and a
    // pause scheduled straight onto the player went out ahead of it.
    if it.pauseMs > 0 {
      if player != nil, let f = it.inFormat, f.commonFormat == .pcmFormatFloat32, !f.isInterleaved, let s = silenceBuffer(ms: it.pauseMs, format: f) {
        it.stash.append((s, false))
      } else if player != nil, let format, let mono = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1),
         let s = silenceBuffer(ms: it.pauseMs, format: mono) { it.stash.append((s, true)) }
      else { it.framesOut += it.pauseMs / 1000 }
    }
    if canPlay(it) { let st = it.stash; it.stash = []; for b in st { play(it, b.buf, silent: b.silent) } }
    it.synthDone = true
    it.doneAt = nowMs()
    flushStashes()
    maybeFinish()
    writeNext()
  }

  /// Lines whose turn has come play what they stashed (in order: a finished one flushes the next).
  private func flushStashes() {
    for x in items {
      if !x.stash.isEmpty && canPlay(x) { let st = x.stash; x.stash = []; for b in st { play(x, b.buf, silent: b.silent) } }
      if !x.synthDone { break }
    }
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
    // write() reports its end with an empty buffer (onSynth). The delegate can report "finished"
    // early — when the next queued sentence's write() starts, while this one's buffers are still
    // arriving — so it is only a late backstop (checkDeadline) for a voice that never sends the empty
    // buffer. The warm-up utterance isn't an item and is ignored.
    let key = ObjectIdentifier(u)
    q.async { if let it = self.byUtterance.removeValue(forKey: key), it.delegateDoneAt == 0 { it.delegateDoneAt = nowMs() } }
  }

  /// Items end in order: a queued sentence can't finish before the one playing ahead of it.
  private func maybeFinish() {
    while let it = items.first, it.synthDone, it.pending <= 0 {
      items.removeFirst()
      log("spoke \(it.id) (\(String(format: "%.1f", it.framesOut)) s)")
      emit(["type": "speak-end", "id": it.id, "interrupted": false, "seconds": it.framesOut])
      onEnd?(it.id)
    }
    if items.isEmpty { audibleSince = 0 }
  }

  /// A reply that never reports played-back (an engine restart dropped its buffers) still ends.
  func checkDeadline(_ now: Double) {
    // Bug 107: a PCM line whose audio stopped arriving (the app lost Kokoro) is said by Apple instead.
    for it in items where it.pcm && !it.synthDone && now - it.lastDataAt > 20_000 { pcmFail(id: it.id, why: "no audio for 20 s") }
    if let it = items.first, !it.synthDone, it.delegateDoneAt > 0, now - it.delegateDoneAt > 1500 { synthesized(it) }
    // Bug 141: held audio hasn't had its chance to play yet (release() restarts the clock).
    guard !holding, let it = items.first, it.synthDone, it.doneAt > 0 else { return }
    // Bug 219: the deadline runs from where the line's last audio sits on the playback timeline. It ran from when
    // the line was SYNTHESIZED, so a line queued behind 3 s+ of audio was ended mid-sentence (110 of 137 real
    // overruns) — and with no line left, barge-in went off for the rest of it. Buffers still waiting to be
    // scheduled (a player switch) mean its end isn't known yet: not overdue. A line with nothing scheduled (no
    // player) keeps the old clock.
    if scheds.contains(where: { $0.item === it && $0.epoch < 0 }) { return }
    var due = it.endsAt > 0 ? it.endsAt + overrunMarginMs : it.doneAt + it.framesOut * 1000 + 3000
    // A render that stalled mid-line (the engine stopped pulling audio) moves the end by as much: never early.
    if it.endsAt > 0, it.anchorWall > 0, let a = it.anchorRender, let r = renderMs(it.anchorNode) {
      let lag = (now - it.anchorWall) - (r - a)
      if lag > 50 { due += min(lag, 10_000) }
    }
    guard now > due else { return }
    log("speech playback overran; ending it (\(Int(now - (it.endsAt > 0 ? it.endsAt : it.doneAt))) ms past its \(it.endsAt > 0 ? "audio" : "synthesis"))")
    it.pending = 0
    scheds.removeAll { $0.item === it }
    maybeFinish()
  }

  /// Cut off everything playing and queued (barge-in, hush, a new reply).
  func stop(interrupted: Bool) {
    guard !items.isEmpty else { return }
    let cut = items
    // Bug 188: something is audibly playing right now — fade it out instead of cutting the waveform dead.
    let audible = audibleSince > 0 && playheadEnd > nowMs() && !holding && engineRunning()
    items = []
    byUtterance = [:]
    scheds = []
    gen += 1
    audibleSince = 0
    outLevels = []
    playheadEnd = 0
    resetSwitch()
    DispatchQueue.main.async { self.synth.stopSpeaking(at: .immediate) }
    if audible, player != nil { fadeOut(nodes) } else { endFade(); for p in nodes { p.stop(); if engineRunning() { p.play() } } }
    for it in cut {
      emit(["type": "speak-end", "id": it.id, "interrupted": interrupted, "seconds": it.framesOut])
      onEnd?(it.id)
    }
  }

  /// Bug 219: a line whose played-back report hasn't come `overrunMarginMs` after its audio's scheduled end is ended
  /// anyway (the report comes after the device has played it — see overrunMargin).
  private(set) var outputLatency = 0.0
  private(set) var outputTransport = ""
  var overrunMarginMs: Double { overrunMargin(latencyMs: outputLatency, transport: outputTransport) }
  /// The output route changed (MicSource.readRoute): its latency and transport set the overrun margin.
  func setOutputLatency(_ ms: Double, transport: String) { outputLatency = ms; outputTransport = transport }

  /// The player's render position in ms (nil: not rendering). Its progress against the wall clock is how a stalled
  /// render is told apart from a lost played-back report.
  private func renderMs(_ node: AVAudioPlayerNode?) -> Double? {
    guard let t = node?.lastRenderTime, t.isSampleTimeValid, t.sampleRate > 0 else { return nil }
    return Double(t.sampleTime) / t.sampleRate * 1000
  }

  /// Bug 188: how long a cut-off line takes to fade out. Long enough that the waveform never steps (a dead
  /// stop left a step on 173 of 175 cut points of a real reply), short enough to still read as "stopped".
  static let fadeMs = 80.0
  private var fadeTimer: DispatchSourceTimer?

  /// The players keep playing what they had while their volume follows a raised cosine to zero, then
  /// stop. Every player at once (bug 213: the direct one and each headphone seat): one fade, one curve.
  /// The line itself has already ended (its speak-end went out), so nothing waits on the fade.
  private func fadeOut(_ ps: [AVAudioPlayerNode]) {
    fadeTimer?.cancel()
    let t0 = nowMs()
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now(), repeating: .milliseconds(4))
    t.setEventHandler { [weak self] in
      guard let self, self.fadeTimer === t else { return }
      let k = (nowMs() - t0) / Speaker.fadeMs
      if k >= 1 { self.endFade(); return }
      let v = Float(0.5 * (1 + cos(Double.pi * k)))
      for p in ps { p.volume = v }
    }
    fadeTimer = t
    t.resume()
  }

  /// End a fade now (it ran out, or something new must play): stop what it was fading, full volume again.
  private func endFade() {
    guard let t = fadeTimer else { return }
    t.cancel()
    fadeTimer = nil
    for p in nodes {
      p.stop()
      p.volume = 1
      if engineRunning() { p.play() }
    }
  }
}

/// Bug 107: pcm {"id","data"} / pcm-end {"id"} / pcm-fail {"id"} → the speaker. True when handled.
func pcmCommand(_ line: String, _ sp: Speaker) -> Bool {
  let verbs = ["pcm ", "pcm-end ", "pcm-fail "]
  guard let verb = verbs.first(where: { line.hasPrefix($0) }) else { return false }
  guard let d = line.dropFirst(verb.count).data(using: .utf8),
        let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let id = o["id"] as? String else { log("bad \(verb)command"); return true }
  switch verb {
  case "pcm ": if let data = o["data"] as? String { sp.pcm(id: id, base64: data) } else { log("pcm without data") }
  case "pcm-end ": sp.pcmEnd(id: id)
  default: sp.pcmFail(id: id)
  }
  return true
}

// ---------- the recognition pipeline ----------
final class Utterance {
  let id: Int
  let req = SFSpeechAudioBufferRecognitionRequest()
  var task: SFSpeechRecognitionTask?
  var text = ""
  var lastPartialAt: Double
  var finishing = false
  var deadline = 0.0
  var done = false
  /// The recognizer marked the end of a speech segment (its result carries metadata) — bug 106.
  var segmentEnded = false
  /// Plan item 16: the Bot's last line asked something when this utterance began (a short answer ends fast).
  var shortAnswer = false
  let startedAt: Double
  /// Wake word: the latest result's words and their confidence (kept in memory only, for the match).
  var segments: [(String, Double)] = []
  /// Bug 142: (ms, dB) of this utterance's voiced frames (the last 3 s), and whether likely-end went out.
  var voiced: [(Double, Double)] = []
  var likelySent = false
  /// 5.8: the words the last likely end went out for, and how many went out. A user who goes on after a likely end
  /// (a mid-thought pause) gets another one at the real end, when new words close a clause — at most LikelyEnds.max.
  var likelyFor = ""
  var likelyCount = 0
  /// 5.8: when this utterance's voice last sounded (the end of the user's speech), for the latency record.
  var voiceEndAt = 0.0
  /// Bug 165: the same 16 kHz mono float samples that went to Apple, kept so whisper can re-read the
  /// whole utterance at the end of the turn. Empty unless whisper is loaded, so Light mode keeps not
  /// one sample: at 64 KB per second this is the only memory the hybrid costs outside the model.
  var pcm: [Float] = []
  /// Bug 165: the utterance ran past what one encoder window holds, so whisper was not asked.
  /// Bug 185: now only past `WhisperLimit.maxSamples` (10 min) of audio whisper was never handed.
  var pcmOverflow = false
  /// Bug 185: the chunks of a long turn already handed to whisper, in order (see `WhisperParts`).
  let parts = WhisperParts()
  /// Bug 185: Apple's text from before its last restart, and its latest raw result.
  var committed = ""
  var raw = ""
  /// Bug 185: finals go out in the order the utterances were spoken, whichever finishes first.
  var resolved = false
  var outcome: [String: Any]? = nil
  init(id: Int, at: Double) {
    self.id = id
    lastPartialAt = at
    startedAt = at
    req.shouldReportPartialResults = true
    req.taskHint = .dictation
    if onDevice { req.requiresOnDeviceRecognition = true }
    if opt.mode == .wake {
      // Biased towards the phrases that matter; no punctuation to strip.
      req.contextualStrings = wakeNames.map { "Hey \($0)" }
    } else {
      // Bug 162: punctuation AND the session's names — the two are not alternatives. Contextual
      // strings are the single biggest accuracy win on names (measured: 16.8% WER to 6.9%,
      // name accuracy 46% to 89%), and they cost nothing at run time.
      if #available(macOS 13.0, *) { req.addsPunctuation = true }
      if !sessionContext.isEmpty { req.contextualStrings = sessionContext }
      // Bug 162: and the compiled model of the user's own vocabulary, if the app has built one.
      // On top of the contextual strings this measured 6.9% WER to 5.2% and 48 of 54 names to 51.
      if #available(macOS 14.0, *), let dir = lmDirInUse { req.customizedLanguageModel = lmConfig(dir) }
    }
  }

  /// Every buffer this utterance is made of goes to Apple, and — when whisper is loaded — is kept so
  /// whisper can re-read the whole turn. The buffers are already the 16 kHz mono float whisper
  /// wants, so nothing is converted and nothing is copied twice.
  ///
  /// Bug 185: this used to stop at one encoder window (30 s) and throw the samples away, so every
  /// turn longer than that was Apple's text. Now the pipeline hands a chunk to whisper every ~28 s
  /// (`Pipeline.feedWhisper`) and `pcm` only holds what has not been handed over yet.
  func take(_ b: AVAudioPCMBuffer) {
    req.append(b)
    guard whisper != nil, !pcmOverflow, let ch = b.floatChannelData else { return }
    let n = Int(b.frameLength)
    if !whisperKeeps(samples: pcm.count + n) { pcmOverflow = true; pcm = []; return }
    pcm.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: n))
  }

  /// What this utterance says so far — its final once it has one, else Apple's live text.
  var shown: String { (outcome?["text"] as? String) ?? text }
}

/// Bug 185: the whisper transcripts of one long turn's chunks. Written on the whisper queue the
/// moment a chunk finishes — so the NEXT chunk, which runs after it on the same serial queue, can
/// take its closing words as context — and read on the pipeline queue for the final.
final class WhisperParts {
  private let lock = NSLock()
  private var texts: [String?] = []
  private var done: [Bool] = []
  var count: Int { lock.lock(); defer { lock.unlock() }; return texts.count }
  func add() -> Int { lock.lock(); defer { lock.unlock() }; texts.append(nil); done.append(false); return texts.count - 1 }
  func set(_ i: Int, _ t: String?) { lock.lock(); texts[i] = t; done[i] = true; lock.unlock() }
  /// The text of the chunk before `i`, if it came back.
  func before(_ i: Int) -> String? { lock.lock(); defer { lock.unlock() }; return i > 0 ? texts[i - 1] : nil }
  /// Every chunk's text, or nil if any of them failed or ran out of budget (Apple's text then stands).
  func all() -> [String]? {
    lock.lock(); defer { lock.unlock() }
    guard done.allSatisfy({ $0 }) else { return nil }
    let t = texts.compactMap { $0 }
    return t.count == texts.count ? t : nil
  }
}

final class Pipeline {
  let source: AudioSource
  let speaker: Speaker?
  private let conv = Converter(to: target)
  /// Noise floor by minimum statistics: the quietest 20 ms frame of the last 3 s. Speech has gaps
  /// between words, so this settles on the room's noise even when the user talks from the first
  /// instant (a calibration window would have eaten those first words).
  private var recentDb: [Double] = []
  private var recentAt = 0
  private var floorDb: Double { min(max(recentDb.min() ?? -60, -90), -40) }
  private var voicedRunMs = 0.0
  private var lastVoicedAt = 0.0
  private var preRoll: [AVAudioPCMBuffer] = []
  private var preRollMs = 0.0
  private var current: Utterance?
  private var finishingList: [Utterance] = []
  private var nextId = 1
  private var heardText = false
  private var gotAudio = false
  private var audioSince = 0.0
  private var lastBufferAt = 0.0
  private var sourceStartedAt = 0.0
  private var restarts: [Double] = []
  private var restartPending = false
  private var muted = false
  private var stopping = false
  private var finished = false
  private var stopWhenFileDone = false
  private var timer: DispatchSourceTimer?
  private var gate = BargeGate()
  private var wasSpeaking = false
  private var lastIgnoreLogAt = 0.0
  /// Bug 165: utterances whose whisper pass is still running. The helper must not exit under one —
  /// that would drop the final the user is waiting for. The budget bounds the wait by construction.
  private var whisperPending = 0
  /// Bug 185: utterances whose final has not gone out yet, oldest first. A short turn that skips
  /// whisper must not overtake a long one still in it — the composer appends finals as they come.
  private var order: [Utterance] = []
  /// Bug 185: when Apple last gave new words (dictation's idle stop counts from here).
  private var lastWordsAt = 0.0

  init(source: AudioSource, speaker: Speaker?) {
    self.source = source
    self.speaker = speaker
    source.onBuffer = { [weak self] b in q.async { self?.ingest(b) } }
    source.onInterrupted = { [weak self] reason in q.async { self?.requestRestart(reason) } }
    // Already on q: the source rebuilt its audio path, so the stall watchdog starts over.
    source.onReconfigured = { [weak self] in
      guard let self else { return }
      self.sourceStartedAt = nowMs()
      self.lastBufferAt = self.sourceStartedAt
    }
    if let f = source as? FileSource {
      f.onFileDone = { [weak self] in
        q.async {
          guard let self, self.stopWhenFileDone else { return }
          q.asyncAfter(deadline: .now() + .milliseconds(Int(opt.silenceMs) + 2500)) { self.stop() }
        }
      }
    }
  }

  func begin() {
    do { try source.start() } catch { fatal("no-audio", "The microphone couldn't start: \(error.localizedDescription)") }
    sourceStartedAt = nowMs()
    emit(["type": "ready", "source": source.name, "mode": opt.mode.rawValue, "onDevice": onDevice])
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    t.setEventHandler { [weak self] in self?.tick() }
    timer = t
    t.resume()
  }

  // ---- audio in ----
  private func ingest(_ buf: AVAudioPCMBuffer) {
    if finished { return }
    let now = nowMs()
    lastBufferAt = now
    if !gotAudio {
      gotAudio = true
      audioSince = now
      log("first audio after \(Int(now - sourceStartedAt)) ms: \(buf.format)")
      emit(["type": "audio", "source": source.name, "sampleRate": buf.format.sampleRate, "channels": Int(buf.format.channelCount)])
    }
    if muted { return }
    guard let mono = conv.convert(buf) else { return }
    let speaking = speaker?.isSpeaking ?? false
    if !speaking && wasSpeaking { gate.reset(); voicedRunMs = 0 }
    wasSpeaking = speaking
    var onset = false
    var barge: String? = nil
    let n = Int(mono.frameLength)
    let s = mono.floatChannelData![0]
    var i = 0
    while i < n {
      let len = min(320, n - i)
      var sum: Float = 0
      for k in 0..<len { sum += s[i + k] * s[i + k] }
      let db = max(-100, 20 * log10(Double(sqrt(sum / Float(len))) + 1e-10))
      let frameMs = Double(len) / 16
      i += len
      if recentDb.count < 150 { recentDb.append(db) } else { recentDb[recentAt] = db; recentAt = (recentAt + 1) % 150 }
      let floorDb = self.floorDb
      reportLevel(db, now)
      if speaking, let sp = speaker {
        // Bug 106: barge-in only on sustained speech above the echo the playback should leave.
        let frameAt = now - Double(n - i) / 16
        let since = sp.audibleSince > 0 ? frameAt - sp.audibleSince : nil
        gate.outputLatencyMs = sp.outputLatency
        gate.gapRule = !(sp.outputTransport.hasPrefix("bluetooth") || sp.outputTransport == "airplay")
        switch gate.frame(db: db, playDb: sp.playbackDb(at: frameAt), sinceOutMs: since, floorDb: floorDb, frameMs: frameMs) {
        case .accept(let why): if barge == nil { barge = why }
        case .ignore(let why): if now - lastIgnoreLogAt >= 500 { lastIgnoreLogAt = now; log("barge-in ignored: \(why)") }
        case .none: break
        }
        continue
      }
      let on = max(floorDb + 12, -52)
      let keep = max(floorDb + 7, -58)
      if db > keep {
        lastVoicedAt = now
        if let u = current { u.voiceEndAt = now - Double(n - i) / 16 }
        if let u = current, opt.mode == .call {
          u.voiced.append((now, db))
          if u.voiced.count > 160 { u.voiced.removeFirst(u.voiced.count - 150) }
        }
      }
      if db > on { voicedRunMs += frameMs } else if db <= keep { voicedRunMs = 0 }
      if voicedRunMs >= 100 { onset = true }
    }
    if speaking {
      remember(mono)
      if let why = barge { bargeIn(why) }
      return // the microphone is muted while the Bot speaks, unless the user barges in
    }
    if let u = current {
      u.take(mono)
      feedWhisper(u)
    } else {
      remember(mono)
      // Bug 185: once stopping, nothing new starts — the old helper opened a fresh utterance after
      // dictation's own stop and then never exited (measured: hung until killed).
      if mayStartUtterance(onset: onset, stopping: stopping) { startUtterance() }
    }
  }

  /// Bug 185: a long turn is handed to whisper in ~28 s chunks WHILE the user is still talking, cut
  /// in the gap between two words, so by the time they stop only the last few seconds are left to
  /// transcribe. The chunks run in order on whisper's own serial queue; each one's closing words are
  /// the next one's context.
  private func feedWhisper(_ u: Utterance) {
    guard let w = whisper, w.isReady, !u.pcmOverflow, u.pcm.count >= WhisperLimit.chunkSamples else { return }
    let cut = whisperCut(u.pcm, from: 0, maxLen: WhisperLimit.chunkSamples, search: WhisperLimit.chunkSearchSamples)
    let piece = Array(u.pcm[0..<cut])
    u.pcm.removeFirst(cut)
    submitWhisper(u, piece, w, last: false)
  }

  /// One whisper pass over `piece`, the next chunk of `u`. `last` is the pass that ends the turn:
  /// when it comes back every chunk before it has too (one serial queue), and the final is decided.
  private func submitWhisper(_ u: Utterance, _ piece: [Float], _ w: WhisperEngine, last: Bool, apple: String = "", endedAt: Double = 0) {
    let i = u.parts.add()
    // A chunk handed over while the user is still talking is off the path to the final, so it gets
    // `backgroundBudgetFactor` times the budget: measured, a looping chunk's full-window re-run took
    // 2035 ms against a 2031 ms budget while other GPU work ran, and one failed chunk costs the whole
    // turn its whisper text. The tail — which the user IS waiting for — keeps the plain budget.
    let budget = whisperBudget(baseMs: opt.whisperBudgetMs, samples: piece.count) * (last ? 1 : WhisperLimit.backgroundBudgetFactor)
    whisperPending += 1
    let parts = u.parts
    w.transcribe(piece, budgetMs: budget, context: { parts.before(i) }) { [weak self] text, ms in
      // On the whisper queue: record it now, so the next chunk (queued behind this one) sees it.
      parts.set(i, ms > budget ? nil : text)
      q.async {
        guard let self else { return }
        self.whisperPending -= 1
        let secs = String(format: "%.1f", Double(piece.count) / 16_000)
        if !last || i > 0 {
          log("utterance \(u.id) whisper chunk \(i + 1): \(secs) s of audio in \(Int(ms)) ms (budget \(Int(budget)) ms)\(text == nil ? ", failed" : "")")
        }
        guard last else { return }
        let stitched = parts.all().map(stitchWhisper)
        let waited = nowMs() - endedAt
        let verdict = whisperWins(apple: apple, whisper: stitched, elapsedMs: ms, budgetMs: budget, chunked: parts.count > 1)
        if verdict.engine == "whisper" {
          log("utterance \(u.id) whisper won in \(Int(waited)) ms (\(parts.count) chunk\(parts.count == 1 ? "" : "s"))")
        } else {
          log("utterance \(u.id) kept Apple's text after \(Int(waited)) ms (\(verdict.why))")
        }
        self.settle(u, verdict.text, engine: verdict.engine, whisperMs: waited)
      }
    }
  }

  /// Voice calls: the mic level (peak dB of the last ~100 ms) and what is playing, for the call screen.
  private var levelPeak = -100.0
  private var levelAt = 0.0
  private func reportLevel(_ db: Double, _ now: Double) {
    guard opt.mode == .call else { return }
    levelPeak = max(levelPeak, db)
    if now - levelAt < 100 { return }
    levelAt = now
    let out: Any = speaker?.playbackDb(at: now).map { ($0 * 10).rounded() / 10 } ?? NSNull()
    emit(["type": "level", "mic": (levelPeak * 10).rounded() / 10, "out": out])
    levelPeak = -100
  }

  private func remember(_ b: AVAudioPCMBuffer) {
    preRoll.append(b)
    preRollMs += Double(b.frameLength) / 16
    while preRollMs > 600, let first = preRoll.first {
      preRoll.removeFirst()
      preRollMs -= Double(first.frameLength) / 16
    }
  }

  private func bargeIn(_ why: String) {
    log("barge-in: \(why)")
    speaker?.stop(interrupted: true)
    emit(["type": "barge-in"])
    startUtterance()
  }

  private func startUtterance() {
    let u = Utterance(id: nextId, at: nowMs())
    // Plan item 16: the app's expect-answer is for the next utterance only.
    if expectAnswer && nowMs() - expectAnswerAt < ShortAnswer.expireMs { u.shortAnswer = true }
    expectAnswer = false
    nextId += 1
    for b in preRoll { u.take(b) }
    preRoll = []
    preRollMs = 0
    lastVoicedAt = nowMs()
    u.task = recognizer.recognitionTask(with: u.req) { [weak self] r, e in self?.onResult(u, r, e) }
    current = u
    if opt.mode != .wake { order.append(u) }
    log("utterance \(u.id) started")
    if opt.mode != .wake { emit(["type": "speech-start"]) } // wake mode says nothing until the name
  }

  private func onResult(_ u: Utterance, _ r: SFSpeechRecognitionResult?, _ e: Error?) {
    if u.done { return }
    if let r {
      var t = r.bestTranscription.formattedString
      var stitched = false
      if opt.mode != .wake {
        // Bug 185: Apple starts its text over after a pause; keep what it said before.
        let m = mergeAppleResult(committed: u.committed, previous: u.raw, next: t)
        if m.committed != u.committed { log("utterance \(u.id) recognizer restarted its text after a pause; kept \(m.committed.split(separator: " ").count) words") }
        stitched = m.committed != u.committed
        u.committed = m.committed
        // An empty result is not the recognizer's new text: keep the stretch it would have replaced.
        if !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { u.raw = t }
        t = m.text
      }
      if t != u.text {
        // Bug 189 relies on lastPartialAt moving only when the words do: a stitch that re-reads the same
        // words (bug 185) is not a new word and must not hold the likely end back.
        if partialMovesClock(old: u.text, new: t, stitched: stitched) { u.lastPartialAt = nowMs(); lastWordsAt = u.lastPartialAt }
        u.text = t; u.segmentEnded = false
      }
      if #available(macOS 11.3, *), r.speechRecognitionMetadata != nil, !r.isFinal { u.segmentEnded = true }
      if opt.mode == .wake {
        u.segments = r.bestTranscription.segments.map { ($0.substring, Double($0.confidence)) }
        // The phrase is there: end the audio now so the final result (with confidences) comes at once.
        if !u.finishing && !r.isFinal && wakeMatch(t, names: wakeNames) != nil { finishUtterance(u, "wake-candidate") }
      } else if !u.finishing && current === u && !t.isEmpty { emitPartial(u) }
      if r.isFinal { complete(u); return }
    }
    guard let e else { return }
    let ns = e as NSError
    log("utterance \(u.id) recognizer error \(ns.domain) \(ns.code): \(ns.localizedDescription)")
    if !u.text.isEmpty { complete(u); return }
    let quiet = ns.code == 1110 || ns.code == 301 || ns.code == 216 || ns.code == 209 || ns.localizedDescription.range(of: "no speech", options: .caseInsensitive) != nil
    if quiet || u.finishing { drop(u); return }
    drop(u)
    fatal("recognizer", "Speech recognition failed: \(ns.localizedDescription)")
  }

  private func drop(_ u: Utterance) {
    u.done = true
    // Plan item 5 (call-behaviour): the app set "the user is talking" on speech-start; an utterance that ends with
    // no final must clear it, or the filler, the end-of-turn sound and a held reply wait for a turn that never comes.
    if opt.mode == .call && !u.resolved { emit(["type": "speech-drop"]) }
    if current === u { current = nil }
    finishingList.removeAll { $0 === u }
    resolve(u, nil)
    maybeFinishStop()
  }

  /// Bug 185: in dictation the composer shows ONE running text: the utterances whose final is still
  /// on its way (whisper is re-reading them) and then the one being spoken. Without the prefix the
  /// words of the previous sentence would vanish from the composer until its final landed.
  private func emitPartial(_ u: Utterance) {
    var text = u.text
    if opt.mode == .dictation {
      let earlier = order.prefix { $0 !== u }.map { $0.shown }.filter { !$0.isEmpty }
      if !earlier.isEmpty { text = (earlier + [text]).joined(separator: " ") }
    }
    emit(["type": "partial", "text": text])
  }

  /// Bug 185: an utterance is over — with a final, or with nothing (`out` nil). Finals leave in
  /// the order their utterances began, so a quick one never overtakes a long one still in whisper.
  private func resolve(_ u: Utterance, _ out: [String: Any]?) {
    guard opt.mode != .wake, !u.resolved else { return }
    u.resolved = true
    u.outcome = out
    var flushed = false
    while let f = order.first, f.resolved {
      order.removeFirst()
      if var o = f.outcome {
        // 5.8: how long ago the user's voice stopped, as the final goes out (the app times the reply from there).
        if o["type"] as? String == "final", f.voiceEndAt > 0 { o["sinceVoiceMs"] = Int(max(0, nowMs() - f.voiceEndAt)) }
        emit(o)
        flushed = true
      }
    }
    // The composer now holds that final; show the sentence in progress after it again.
    if flushed, opt.mode == .dictation, let c = current, !c.finishing, !c.text.isEmpty { emitPartial(c) }
  }

  private func finishUtterance(_ u: Utterance, _ why: String = "stopped") {
    guard !u.finishing else { return }
    u.finishing = true
    u.deadline = nowMs() + 2000
    u.req.endAudio()
    if current === u { current = nil }
    finishingList.append(u)
    log("utterance \(u.id) end of turn (\(why))")
  }

  private func complete(_ u: Utterance) {
    if u.done { return }
    u.done = true
    if current === u { current = nil }
    finishingList.removeAll { $0 === u }
    let raw = u.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if opt.mode == .wake { checkWake(u, raw); maybeFinishStop(); return }
    // Bug 165: the turn is over and Apple's last partial is on screen. Whisper now re-reads the
    // whole utterance — on its own queue, so the microphone keeps running — and its text becomes
    // the final if it comes back inside the budget and looks like the same sentence.
    //
    // Bug 185: a turn longer than ~28 s has already had its earlier chunks handed over while the
    // user talked; what is left is the tail, and the verdict waits for it (and so for them all).
    // The budget grows with the audio instead of the flat 900 ms that aborted every long turn.
    let chunked = u.parts.count > 0
    guard let w = whisper, w.isReady, !raw.isEmpty, !u.pcmOverflow, chunked || u.pcm.count >= WhisperLimit.minSamples else {
      if whisper != nil && !raw.isEmpty {
        let why = u.pcmOverflow ? "the utterance ran past \(WhisperLimit.maxSamples / 16_000 / 60) minutes before the model was ready"
          : whisper?.isReady == false ? "the model is still loading" : "too little audio"
        log("utterance \(u.id) skipped whisper: \(why)")
      }
      settle(u, raw, engine: "apple", whisperMs: nil)
      return
    }
    var tail = u.pcm
    u.pcm = []
    // A few hundred ms left after the last cut is usually the pause before the stop; padded to
    // whisper's floor it transcribes as nothing, and the stitch drops whisper's silence filler.
    if tail.count < WhisperLimit.minSamples { tail += [Float](repeating: 0, count: WhisperLimit.minSamples - tail.count) }
    submitWhisper(u, tail, w, last: true, apple: raw, endedAt: nowMs())
  }

  /// Bug 165: the last stretch of a turn, whichever engine's words won it. Post-correction and the
  /// spoken commands run over the winning transcript — never over both, and never twice.
  private func settle(_ u: Utterance, _ won: String, engine: String, whisperMs: Double?) {
    // Bug 162: the cheap fixer runs on the final only — partials stay raw so the live text does not
    // twitch as the user talks. Spoken commands are dictation's alone: in a call "period" is a word.
    let t = postCorrect(won, names: sessionContext, commands: opt.mode == .dictation)
    if !t.isEmpty {
      heardText = true
      if t != won { log("utterance \(u.id) post-correction changed the text") }
      log("utterance \(u.id) final: \(t.count) chars (\(engine)\(whisperMs.map { ", whisper \(Int($0)) ms" } ?? ""))")
      var out: [String: Any] = ["type": "final", "text": t, "engine": engine]
      if let whisperMs { out["whisperMs"] = Int(whisperMs) }
      // Bug 185: dictation no longer ends with its first sentence — a pause is not the end of what
      // the user is saying. It ends on stop, or after --idle-stop-ms with no new words (tick).
      resolve(u, out)
    } else {
      resolve(u, nil)
    }
    maybeFinishStop()
  }

  /// Wake word: fire on "hey <name>" at or above the confidence threshold. The words are dropped
  /// either way; only the Bot's name and the confidence are reported (and logged).
  private var lastWakeAt = -10_000.0
  /// Plan item 16: the app said the Bot's last line was a question (cleared by the next utterance).
  private var expectAnswer = false
  private var expectAnswerAt = 0.0
  private func checkWake(_ u: Utterance, _ text: String) {
    defer { u.segments = []; u.text = "" }
    guard let heard = wakeMatch(text, names: wakeNames) else { return }
    let scored = wakeConfidence(segments: u.segments, names: wakeNames)
    let name = scored?.0.name ?? heard.name
    // Bug 213: "Hey Nova and Scout" — each extra name on its own confidence (a doubtful one is dropped,
    // the call still starts with the rest).
    let also = scored.map { s in zip(s.0.also, s.2).filter { $0.1 >= opt.wakeThreshold }.map { $0.0 } } ?? []
    let conf = ((scored?.1 ?? 0) * 100).rounded() / 100
    let now = nowMs()
    if conf < opt.wakeThreshold {
      log("wake rejected: \(name) confidence=\(conf) < \(opt.wakeThreshold)")
      emit(["type": "wake-rejected", "name": name, "confidence": conf])
      return
    }
    if now - lastWakeAt < 3000 { log("wake ignored: \(name) again within 3 s"); return }
    lastWakeAt = now
    log("wake: \(name) confidence=\(conf) \(Int(now - u.startedAt)) ms after the utterance began")
    var ev: [String: Any] = ["type": "wake", "name": name, "confidence": conf, "ms": Int(now - u.startedAt)]
    if !also.isEmpty { ev["also"] = also; log("wake: and \(also.joined(separator: ", "))") }
    emit(ev)
  }

  // ---- timers: end of turn, no speech, a stalled source, a speech overrun ----
  private func tick() {
    if finished { return }
    let now = nowMs()
    // Wake word: the phrase is short; a long stretch of talk nearby is cut into short windows.
    if opt.mode == .wake, let u = current, !u.finishing, now - u.startedAt > 4000 { finishUtterance(u, "wake-window") }
    for u in finishingList where !u.done && now > u.deadline {
      log("utterance \(u.id) final result late; using the last partial")
      u.task?.cancel()
      complete(u)
    }
    if let u = current, !u.finishing {
      let last = max(lastVoicedAt, u.lastPartialAt)
      let sinceWords = now - u.lastPartialAt
      // Bug 189: the END of turn keeps its clock (from the later of the voice and the last partial; see turnSilence).
      let silence = now - last
      let eot = endOfTurn(text: u.text, silenceMs: silence, sinceWordsMs: sinceWords, baseMs: opt.silenceMs, segmentEnded: u.segmentEnded, shortAnswer: u.shortAnswer)
      // Bug 142: a likely end goes out before the window runs out, so the app can start the reply early. 5.8: once per
      // stretch of words — a user who went on after one (a mid-thought pause) gets another at the real end.
      if opt.mode == .call && likelyAgain(sent: u.likelySent, sentFor: u.likelyFor, count: u.likelyCount, text: u.text) && !eot.done && !u.text.isEmpty {
        let fall = tailFall(u.voiced)
        let quiet = turnSilence(voiceSilenceMs: now - lastVoicedAt, sinceWordsMs: sinceWords, settleMs: WordsSettle.likelyMs)
        // (Plan item 16 ends a short answer sooner but gives it no early likely end: one sent in the pause after
        // "Yes," was the utterance's only one — measured, "Yes, … and also book the hotel" then started 0.6 s later.)
        let le = likelyEnd(text: u.text, silenceMs: quiet, segmentEnded: u.segmentEnded, tailFallDb: fall)
        if le.likely {
          u.likelySent = true
          u.likelyFor = u.text
          u.likelyCount += 1
          log("utterance \(u.id) likely end after \(Int(quiet)) ms (window \(Int(le.windowMs)) ms, fall \(fall.map { String(Int($0.rounded())) } ?? "-") dB)")
          emit(["type": "likely-end", "text": u.text])
        }
      }
      if !u.text.isEmpty && eot.done {
        finishUtterance(u, "reason=\(eot.reason), silence=\(Int(silence))ms, window=\(Int(eot.windowMs))ms, words=\(u.text.split(separator: " ").count)")
      } else if u.text.isEmpty && now - last >= opt.silenceMs + 1500 {
        log("utterance \(u.id) had no words; dropped")
        u.task?.cancel()
        drop(u)
      }
    }
    // Bug 165: `whisperPending` keeps this from firing while whisper is re-reading a turn the user
    // definitely spoke — `heardText` is not set until its final goes out.
    if opt.mode == .dictation && !stopping && gotAudio
      && dictationNoSpeech(heardText: heardText, turnOpen: current != nil || !finishingList.isEmpty, pending: whisperPending > 0, sinceAudioMs: now - audioSince, noSpeechMs: opt.noSpeechMs) {
      fatal("no-speech", "No speech detected", status: 0)
    }
    // Bug 185: dictation used to END at the first pause long enough to close a turn (0.4-1.8 s), so
    // a speech became its first sentence. Now each pause only closes a sentence (whisper re-reads it
    // while the user goes on) and dictation itself stops on the second press, or after
    // --idle-stop-ms (10 s) with no new words — never while a turn or a whisper pass is in flight.
    // (A voiced sound with no words — a cough — opens an utterance but does not hold dictation open.)
    if opt.mode == .dictation && !stopping
      && dictationIdleStop(heardText: heardText, turnOpen: !(current?.text.isEmpty ?? true) || !finishingList.isEmpty, pending: whisperPending > 0, sinceWordsMs: now - lastWordsAt, idleMs: opt.idleStopMs) {
      log("no new words for \(Int(now - lastWordsAt)) ms; dictation stops")
      stop()
    }
    speaker?.checkDeadline(now)
    if let why = stallWatchdogRestart(stopping: stopping, restartPending: restartPending, sourceRecovering: source.recovering,
                                      gotAudio: gotAudio, sinceMs: gotAudio ? now - lastBufferAt : now - sourceStartedAt) {
      requestRestart(why)
    }
  }

  private func requestRestart(_ reason: String) {
    if finished || stopping || restartPending { return }
    // Bug 196: the source's own backoff (~6 s) already ran out; another restart would only start a
    // new one (and ~6 s chains slip under the 4-in-20 s cap forever). End cleanly instead.
    if reason == "input-not-ready" {
      fatal("no-audio", "The microphone has no usable input (it may be switching devices). Check the input device in System Settings → Sound, then try again.")
    }
    let now = nowMs()
    restarts = restarts.filter { now - $0 < 20_000 }
    if restarts.count >= 4 {
      fatal("no-audio", "The microphone isn't sending any sound (\(reason), restarted \(restarts.count) times). Check the input device in System Settings → Sound, then try again.")
    }
    restarts.append(now)
    restartPending = true
    log("restarting the audio source (\(reason))")
    emit(["type": "audio-restart", "reason": reason])
    // Bug 141: the engine is in flux from now on; speech waits (and is replayed) rather than lost.
    speaker?.pathStopping()
    q.asyncAfter(deadline: .now() + .milliseconds(150)) { [self] in
      restartPending = false
      if finished { return }
      do { try source.restart() } catch { fatal("no-audio", "The microphone couldn't restart: \(error.localizedDescription)") }
      sourceStartedAt = nowMs()
      lastBufferAt = sourceStartedAt
    }
  }

  // ---- commands ----
  func command(_ line: String) {
    // Bug 198: the phone's microphone (the hottest line on stdin, so it is checked first).
    if line.hasPrefix("mic ") { (source as? RemoteSource)?.feed(base64: String(line.dropFirst(4))); return }
    if line == "stop" { stop(); return }
    if line == "hush" { speaker?.stop(interrupted: true); return }
    if line == "expect-answer" { expectAnswer = true; expectAnswerAt = nowMs(); log("expecting a short answer"); return }
    if line == "mute" || line == "unmute" {
      muted = line == "mute"
      if muted, let u = current { if u.text.isEmpty { u.task?.cancel(); drop(u) } else { finishUtterance(u, "reason=muted") } }
      preRoll = []; preRollMs = 0; voicedRunMs = 0
      log(muted ? "muted" : "unmuted")
      emit(["type": "muted", "muted": muted])
      return
    }
    if line.hasPrefix("devices ") {
      // Bug 105: a new microphone / speaker mid-session; null = the system default.
      guard let d = line.dropFirst(8).data(using: .utf8),
            let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { log("bad devices command"); return }
      let input = o["input"] as? String, output = o["output"] as? String
      log("devices command: input=\(input ?? "default") output=\(output ?? "default")")
      do { try source.switchDevices(input: input, output: output) } catch { fatal("no-audio", "The audio devices couldn't start: \(error.localizedDescription)") }
      sourceStartedAt = nowMs()
      lastBufferAt = sourceStartedAt
      return
    }
    if line == "spatial on" || line == "spatial off" {
      // Bug 134: a group call's voices in stereo seats (or back to mono), keeping the session.
      do { try source.setSpatial(line == "spatial on") } catch {
        log("spatial change failed (\(error.localizedDescription)); back to mono")
        emit(["type": "spatial-unavailable", "reason": String(error.localizedDescription.prefix(200))])
        do { try source.setSpatial(false) } catch { fatal("no-audio", "The audio couldn't restart: \(error.localizedDescription)") }
      }
      sourceStartedAt = nowMs()
      lastBufferAt = sourceStartedAt
      return
    }
    if line.hasPrefix("seats ") {
      // Bug 213 (review): the Bots on a group call; a Bot that left gives its headphone seat back.
      guard let d = line.dropFirst(6).data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
            let ids = o["ids"] as? [String] else { log("bad seats command"); return }
      speaker?.keepSeats(Array(ids.prefix(12)))
      return
    }
    if line.hasPrefix("fx ") {
      guard let d = line.dropFirst(3).data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
            let data = o["data"] as? String, let buf = pcmBuffer(base64: data), buf.frameLength <= 24000 * 2 else { log("bad fx command"); return }
      source.playFx(buf)
      return
    }
    if line.hasPrefix("names ") {
      // Wake word: a Bot was added, removed or renamed.
      guard let d = line.dropFirst(6).data(using: .utf8),
            let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let n = o["names"] as? [String] else { log("bad names command"); return }
      wakeNames = cleanNames(n)
      log("listening for \(wakeNames.count) names")
      return
    }
    if line.hasPrefix("context ") {
      // Bug 162: the app moved to another chat, or the Bot / contact list changed. The next
      // utterance is biased towards the new list; the one in flight keeps the old one.
      guard let d = line.dropFirst(8).data(using: .utf8),
            let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
            let s = o["strings"] as? [String] else { log("bad context command"); return }
      sessionContext = cleanContext(s)
      log("context: \(sessionContext.count) strings")
      return
    }
    if line.hasPrefix("speak ") {
      guard let d = line.dropFirst(6).data(using: .utf8),
            let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
            let id = o["id"] as? String, let text = o["text"] as? String else { log("bad speak command"); return }
      guard let speaker else {
        emit(["type": "speak-end", "id": id, "interrupted": true, "seconds": 0]); return
      }
      if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        emit(["type": "speak-end", "id": id, "interrupted": false, "seconds": 0]); return
      }
      // Whatever the user was mid-way through saying ends here; the Bot now has the floor.
      if let u = current { if u.text.isEmpty { u.task?.cancel(); drop(u) } else { finishUtterance(u, "reason=bot-spoke") } }
      speaker.speak(id: id, text: text, voice: o["voice"] as? String, rate: o["rate"] as? Double, lang: o["lang"] as? String, queue: o["queue"] as? Bool ?? false,
                    engine: o["engine"] as? String, pauseMs: o["pauseMs"] as? Double ?? 0, pan: o["pan"] as? Double ?? 0,
                    azimuth: o["azimuth"] as? Double, seat: o["seat"] as? String)
      return
    }
    if let sp = speaker, pcmCommand(line, sp) { return }
    if !line.isEmpty { log("unknown command: \(line.prefix(40))") }
  }

  func stdinClosed() {
    if source is FileSource { stopWhenFileDone = true; log("stdin closed; stopping once the file has played"); return }
    log("stdin closed")
    stop()
  }

  func stop() {
    if stopping || finished { return }
    stopping = true
    speaker?.stop(interrupted: true)
    if let u = current { if u.text.isEmpty { u.task?.cancel(); drop(u) } else { finishUtterance(u, "reason=stopped") } }
    maybeFinishStop()
  }

  private func maybeFinishStop() {
    guard stopping, !finished, current == nil, finishingList.isEmpty, whisperPending == 0 else { return }
    finished = true
    source.stop()
    log("end")
    emit(["type": "end"])
    leave(0)
  }

  private func fatal(_ code: String, _ message: String, status: Int32 = 1) -> Never {
    finished = true
    source.stop()
    fail(code, message, status)
  }
}

// ---------- wiring ----------
let source: AudioSource
do {
  if let f = opt.file { source = try FileSource(path: f, simulate: opt.simulate) }
  else if opt.remoteAudio && opt.mode == .call { source = RemoteSource() }
  else { source = MicSource(voiceProcessing: opt.voiceProcessing && opt.mode == .call, playback: opt.mode == .call, input: opt.inputDevice, output: opt.outputDevice, spatial: opt.spatialAtStart, spatialRoute: opt.spatialRoute) }
} catch {
  fail("no-audio", "The audio file couldn't be opened: \(error.localizedDescription)", 1)
}
let mic = source as? MicSource
let remote = source as? RemoteSource
// Bug 141: a call's first line waits until the audio path has settled (voice processing posts a
// configuration change within ~0.1–0.3 s of its first start, which restarts the engine).
// Bug 198: a phone call's offline engine has no device to settle and counts a buffer done once rendered.
let speaker: Speaker? = opt.mode != .call ? nil
  : remote.map { r in Speaker(player: r.player, format: r.playerFormat, engineRunning: { r.engine.isRunning }, holdUntilStarted: false, playedBack: .dataRendered) }
  ?? Speaker(player: mic?.player, format: mic?.playerFormat, engineRunning: { mic?.engine.isRunning ?? false }, holdUntilStarted: mic != nil)
remote?.onPathStarted = { speaker?.pathStarted(settleMs: 0) }
mic?.onOutput = { f, seats, mode in speaker?.setOutput(format: f, seats: seats, mode: mode) }
mic?.onOutputLatency = { ms, transport in q.async { speaker?.setOutputLatency(ms, transport: transport) } }
mic?.onPathStopping = { speaker?.pathStopping() }
mic?.onPathStarted = { speaker?.pathStarted(settleMs: LIMIT_PATH_SETTLE_MS) }
let pipeline = Pipeline(source: source, speaker: speaker)
q.async { speaker?.prewarm() }
q.async { pipeline.begin() }
Thread {
  while let line = readLine() {
    let l = line.trimmingCharacters(in: .whitespaces)
    q.async { pipeline.command(l) }
  }
  q.async { pipeline.stdinClosed() }
}.start()
RunLoop.main.run()
