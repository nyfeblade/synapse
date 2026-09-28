export function listVoices(synth: SpeechSynthesis | undefined = globalThis.speechSynthesis): { name: string; lang: string }[] {
  return (synth?.getVoices() ?? []).map((v) => ({ name: v.name, lang: v.lang }));
}

// `name` is optional (not read) so this also accepts listVoices()'s { name, lang } results and the
// test's inline { name, lang } literals without tripping strict TS's excess-property check.
export function languageOptions(voices: { lang: string; name?: string }[]): { lang: string; label: string }[] {
  const names = new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard" });
  return [...new Set(voices.map((v) => v.lang))].sort().map((lang) => ({ lang, label: names.of(lang) ?? lang }));
}

export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/^\s*[-+]\s+(.*)$/gm, "$1.")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\.\.+/g, ".")
    .trim()
    .replace(/\.$/, "");
}

/**
 * Bug 157: a saved voice is the helper's identifier ("com.apple.voice.premium.en-US.Ava", or a Siri
 * bundle "com.apple.ttsbundle.siri_Aaron_en-US_premium"); the page's own voices only have names.
 * The name inside the identifier is what the page can match — a bare name is already one.
 */
export function voiceNameOf(voice: string): string {
  const siri = /siri_([A-Za-z]+)_/.exec(voice);
  return siri ? siri[1]! : (voice.split(".").pop() || voice);
}

export function speak(text: string, o: { voice?: string | null; rate?: number; lang?: string | null }, synth: SpeechSynthesis | undefined = globalThis.speechSynthesis): Promise<void> {
  return new Promise((resolve) => {
    if (!synth) return resolve();
    const u = new SpeechSynthesisUtterance(plainText(text));
    const want = o.voice;
    // The page speaks only when there is no live helper: an identifier can't be handed to it, so the
    // nearest thing it does have — that voice's name — is used instead of some unrelated default.
    const v = want ? (synth.getVoices().find((x) => x.name === want || x.voiceURI === want) ?? synth.getVoices().find((x) => x.name === voiceNameOf(want))) : undefined;
    if (v) u.voice = v;
    if (o.lang) u.lang = o.lang;
    u.rate = o.rate ?? 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
}

export function cancelSpeech(synth: SpeechSynthesis | undefined = globalThis.speechSynthesis): void {
  synth?.cancel();
}
