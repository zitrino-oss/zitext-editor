/** Find in Files results from the search_in_files command. */
export interface SearchMatch {
    file_path: string;
    line_number: number;
    line_content: string;
    match_start: number;
    match_end: number;
}

/** search_in_files: the matches and what the search could not cover. */
export interface SearchReport {
    matches: SearchMatch[];
    resultLimitReached: boolean;
    stoppedEarly: boolean;
    skippedLargeFiles: number;
    skippedEncodingFiles: number;
    skippedDeepFolders: number;
    /** Symbolic links not followed (they could lead outside the folder). */
    skippedLinks?: number;
}

/** Why a search may have missed matches, for the line under the summary. */
export function incompleteSearchNotes(report: SearchReport): string[] {
    const notes: string[] = [];
    if (report.resultLimitReached) notes.push(`Showing the first ${report.matches.length} results.`);
    if (report.stoppedEarly) notes.push('The search stopped early (time or size limit); some files were not searched.');
    const skipped: string[] = [];
    if (report.skippedLargeFiles) skipped.push(`${report.skippedLargeFiles} large file${report.skippedLargeFiles === 1 ? '' : 's'}`);
    if (report.skippedEncodingFiles) skipped.push(`${report.skippedEncodingFiles} UTF-16 file${report.skippedEncodingFiles === 1 ? '' : 's'}`);
    if (report.skippedDeepFolders) skipped.push(`${report.skippedDeepFolders} deeply nested folder${report.skippedDeepFolders === 1 ? '' : 's'}`);
    if (report.skippedLinks) skipped.push(`${report.skippedLinks} symbolic link${report.skippedLinks === 1 ? '' : 's'}`);
    if (skipped.length) notes.push(`Not searched: ${skipped.join(', ')}.`);
    return notes;
}
