/** Types for info-plist.mjs (the Info.plist keys package.mjs adds). */
export const APP_BUNDLE_ID: string;
export function extendInfo(bundleName: string): {
  CFBundleDisplayName: string;
  LSMinimumSystemVersion: string;
  LSArchitecturePriority: string[];
  NSMicrophoneUsageDescription: string;
  NSSpeechRecognitionUsageDescription: string;
  CFBundleURLTypes: Array<{ CFBundleURLName: string; CFBundleURLSchemes: string[] }>;
  CFBundleDocumentTypes: Array<{ CFBundleTypeName: string; CFBundleTypeRole: string; LSHandlerRank: string; CFBundleTypeExtensions: string[] }>;
  UTExportedTypeDeclarations: unknown[];
};
