/**
 * Native dsh commands for the keybal adapter. These are the model-visible
 * handle for pool administration: they read live pool state from the
 * registered balancers and edit the `llm-keybal` settings section through the
 * settings service, so every change lands on the same validated path a
 * settings document edit uses (a refused write leaves the previous
 * configuration serving).
 *
 * Both `commands` and `settings` are optional services here: a bare keybal
 * mount must still start (and serve) in a composition without them, so the
 * commands simply do not register and the read helpers degrade to undefined.
 *
 * @module dsh-llm-keybal/commands
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { type SettingsProvider } from '@deepseek-ai/dsh-settings';
import type { KeyBalRoute } from './adapter.ts';
import type { KeyBalStrategy } from './config.ts';
/** The live configuration surface the commands edit. */
export interface CommandConfigSource {
    providers: Record<string, {
        displayName?: string;
        strategy?: KeyBalStrategy;
        models: Record<string, {
            keys?: string[];
        }>;
    }>;
}
/** The optional services a keybal command needs, resolved per invocation. */
export interface CommandServices {
    /** Settings provider owning the `llm-keybal` section, when present. */
    settings: SettingsProvider | undefined;
    /** The command registry, when present. */
    commands: CommandRuntime | undefined;
}
/**
 * Render the live pool status for every route, one line per model pool.
 * @param routes - the provider-function route map (re-read per request).
 */
export declare function renderStatus(routes: ReadonlyMap<string, KeyBalRoute>): string;
/**
 * Render the provider/model directory from the current configuration.
 * @param config - the live resolved configuration.
 */
export declare function renderProviders(config: CommandConfigSource): string;
/** Resolve the optional command services a keybal command needs. */
export declare function commandServices(ctx: Context): CommandServices;
/**
 * Register the keybal native commands on a context, each as a disposable
 * effect. When the `commands` service is absent nothing registers; when the
 * `settings` service is absent the mutating commands report an error instead
 * of persisting.
 * @param ctx - the plugin context.
 * @param routes - provider-function route map (live state source).
 * @param config - live configuration reader.
 */
export declare function installCommands(ctx: Context, routes: () => ReadonlyMap<string, KeyBalRoute>, config: () => CommandConfigSource): void;
//# sourceMappingURL=commands.d.ts.map