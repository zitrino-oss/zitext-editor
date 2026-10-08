/**
 * Work that can take long on a large or unusual document. The
 * same functions run in a background worker (workers/heavyTasks.worker.ts)
 * or, where workers are unavailable (tests), directly.
 */
import { formatJson, minifyJson, sortJsonKeys } from './jsonTools';
import { formatYaml } from './xmlYamlTools';
import { computeDiff, type DiffOptions } from './textDiff';

export type HeavyTask =
    | { kind: 'formatJson'; text: string; indent: number }
    | { kind: 'minifyJson'; text: string }
    | { kind: 'sortJsonKeys'; text: string; indent: number }
    | { kind: 'formatYaml'; text: string; indent: number }
    /** Runs a regular expression over the text once, to see that it finishes. */
    | { kind: 'regexRun'; pattern: string; flags: string; text: string; allMatches?: boolean }
    /** Compares two documents' lines; the result is the DiffResult as JSON. */
    | { kind: 'diff'; left: string[]; right: string[]; options: DiffOptions };

/** Stops a regex run after this many matches; enough to know it completes. */
const MAX_REGEX_MATCHES = 20_000;

export function runHeavyTask(task: HeavyTask): string {
    switch (task.kind) {
        case 'formatJson': return formatJson(task.text, task.indent);
        case 'minifyJson': return minifyJson(task.text);
        case 'sortJsonKeys': return sortJsonKeys(task.text, task.indent);
        case 'formatYaml': return formatYaml(task.text, task.indent);
        case 'regexRun': {
            const regex = new RegExp(task.pattern, task.flags.includes('g') ? task.flags : `${task.flags}g`);
            let count = 0;
            // allMatches: the whole text, as a mark runs it (the caller's
            // time limit bounds the run instead).
            const limit = task.allMatches ? Infinity : MAX_REGEX_MATCHES;
            for (let match = regex.exec(task.text); match && count < limit; match = regex.exec(task.text)) {
                count++;
                if (match[0] === '') regex.lastIndex++; // empty match: move on
            }
            return String(count);
        }
        case 'diff': return JSON.stringify(computeDiff(task.left, task.right, task.options));
    }
}
