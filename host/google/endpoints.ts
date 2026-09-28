/** Where the connector talks to Google. FUZZ/E2E points the token and API endpoints at the local stub (fake-google.ts). */
export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  gmail: string;
  calendar: string;
  drive: string;
  upload: string;
}

export const REAL_GOOGLE: GoogleEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  gmail: "https://gmail.googleapis.com/gmail/v1",
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
  upload: "https://www.googleapis.com/upload/drive/v3",
};

/** The FUZZ consent page stays on example.com: the guarded openExternal completes the loopback itself and never opens a browser. */
export const FAKE_AUTH_URL = "https://example.com/authorize";

export function stubEndpoints(base: string): GoogleEndpoints {
  return {
    authUrl: FAKE_AUTH_URL,
    tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`,
    gmail: `${base}/gmail/v1`,
    calendar: `${base}/calendar/v3`,
    drive: `${base}/drive/v3`,
    upload: `${base}/upload/drive/v3`,
  };
}
