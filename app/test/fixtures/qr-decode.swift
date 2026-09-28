// Bug 198: decodes QR codes in PNG files with macOS's own detector (CoreImage), one line per file.
// Used by phone-qr.test.ts to prove the QR encoder's output scans. Prints "<file>\t<text>" or "<file>\t".
import CoreImage
import Foundation

let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
for path in CommandLine.arguments.dropFirst() {
  guard let img = CIImage(contentsOf: URL(fileURLWithPath: path)) else { print("\(path)\t"); continue }
  let text = detector.features(in: img).compactMap { ($0 as? CIQRCodeFeature)?.messageString }.first ?? ""
  print("\(path)\t\(text)")
}
