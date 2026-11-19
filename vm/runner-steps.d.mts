// Types for vm/runner-steps.mjs: the one copy of the steps that set a Bops runner up on a bot's computer, used by
// lib/server/runner-install.ts on the Mac and by the computer's own keeper.

export declare const ROOT: "/opt/bops/runner";
export declare const PORT: 3210;
export declare const RUNNER_CONF: "/etc/supervisor/conf.d/bops-runner.conf";
export declare const RUNNER_WRAPPER: "/opt/bops/runner/run.sh";
export declare const RUNNER_AUTH_FILE: "/opt/bops/runner/auth";
export declare const RUNNER_TURNS_DIR: "/var/run/bops/turns";
export declare const RUNNER_HOLD: "/var/run/bops/upgrading";
export declare const RUNNER_WORKING: "/var/run/bops/working";
export declare const RUNNER_KEEPER_LOOK: "/var/run/bops/keeper-look";

export declare const KEEPER_DIR: "/opt/bops/keeper";
export declare const KEEPER_HOLD: "/var/run/bops/keeper-hold";
export declare const KEEPER_CONF_FILE: "/etc/supervisor/conf.d/bops-keeper.conf";
export declare const KEEPER_CONF: string;

export declare const BUNDLE_NAME: RegExp;
export declare const q: (s: string) => string;
export declare const ORGO_KEY_FILES: readonly string[];
export declare const ORGO_KEY_LINE: string;
export declare const KEY_LINE: string;
export declare const AUTH_LINE: string;
export declare const BUSY_EXIT: string;
export declare const WORKING_EXIT: string;
export declare const BUSY_LINE: string;

export declare function wrapperScript(o: { computerId: string; timeZone?: string; orgo: string; cloud: string }): string;
export declare const SUPERVISOR_CONF: string;
export type InstallOptions = {
  /** A build's folder (<version>-<BUILD_ID>) the cleanup leaves in place: the keeper's previous build, for its rollback. */
  keep?: string;
  /** true writes KEEPER_DIR/pin (a dev build the Mac set up), false takes it off (a packaged one); left out, neither. */
  pin?: boolean;
};
export declare function installScript(b: { name: string; sha256: string; version: string; buildId: string }, wrapper: string, opts?: InstallOptions): string;
export declare const HEALTH_SCRIPT: string;
export declare const UNINSTALL_SCRIPT: string;

/** A runner release, as its signed payload says it (runner/latest.json). */
export type RunnerRelease = {
  kind: "bops-runner";
  version: string;
  buildId: string;
  name: string;
  sha256: string;
  size: number;
  released: string;
  stateLevel: number;
};
export declare const RELEASE_KEYS: Readonly<Record<string, string>>;
export declare const RELEASE_MAX_SIZE: number;
export declare const RELEASE_MAX_TEXT: number;
export declare function verifyRelease(text: string, keys?: Readonly<Record<string, string>>): RunnerRelease | null;
