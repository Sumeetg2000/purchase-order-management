// Types for dev-env.mjs, so the backend test can pin its variables to the API config.
export declare function apiDevEnv(
  dotenv: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined>;
export declare function composeFileArgs(root?: string): string[];
