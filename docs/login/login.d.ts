// Types for login.js, used by the Node tests.

export declare const HANDLER_SCHEME: string;
export declare const CODE_PREFIX: string;
export declare const KDF_INFO: string;
export declare const PENDING_TTL_MS: number;

export interface StartParams {
  site: string;
  passport: string;
  pk: string;
}

export declare function base64urlEncode(bytes: Uint8Array): string;
export declare function base64urlDecode(text: string): Uint8Array;
export declare function parseStartParams(params: URLSearchParams): StartParams | null;
export declare function moodleLaunchUrl(site: string, passport: string): string;
export declare function decodeTokenLink(text: string): { siteId: string; token: string } | null;
export declare function encryptForServer(serverPublicKey: string, passport: string, plaintext: string): Promise<string>;
export declare function codeFromTokenLink(link: string, pending: StartParams): Promise<string | null>;
