// Types for security-headers.mjs, so TypeScript (end-to-end tests, Vite config) can import it.
export declare const CONTENT_SECURITY_POLICY: string;
export declare const SECURITY_HEADERS: Readonly<Record<string, string>>;
export declare function devContentSecurityPolicy(nonce: string): string;
