// Simple heuristic-based language detection from code content
export function detectLanguageFromContent(content: string): string | null {
    if (!content || content.trim().length < 10) {
        return null; // Too short to detect
    }

    const trimmed = content.trim();

    // HTML detection
    if (trimmed.includes('<!DOCTYPE') || trimmed.includes('<html') ||
        /<[a-z][\s\S]*>/i.test(trimmed) && trimmed.includes('</')) {
        return 'html';
    }

    // CSS detection
    if (/[.#]?[\w-]+\s*\{[\s\S]*\}/.test(trimmed) &&
        (trimmed.includes(':') && trimmed.includes(';'))) {
        // Check for CSS properties
        if (/(?:color|background|margin|padding|display|position|font|border):/i.test(trimmed)) {
            return 'css';
        }
    }

    // JSON detection
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            JSON.parse(trimmed);
            return 'json';
        } catch {
            // Not valid JSON
        }
    }

    // XML detection
    if (trimmed.startsWith('<?xml') || (trimmed.startsWith('<') && trimmed.endsWith('>') && !trimmed.includes('html'))) {
        return 'xml';
    }

    // Python detection
    if (/^(def|class|import|from|if __name__|print\()/m.test(trimmed) ||
        trimmed.includes('import ') && trimmed.includes(':')) {
        return 'python';
    }

    // JavaScript/TypeScript detection
    if (/^(function|const|let|var|class|import|export|=>)/m.test(trimmed) ||
        trimmed.includes('console.log') || trimmed.includes('document.')) {
        // Check for TypeScript-specific syntax
        if (/:\s*(string|number|boolean|any|void|interface|type)\b/.test(trimmed)) {
            return 'typescript';
        }
        return 'javascript';
    }

    // Java detection
    if (/^(public|private|protected)\s+(class|interface|enum)/m.test(trimmed) ||
        trimmed.includes('System.out.println')) {
        return 'java';
    }

    // C/C++ detection
    if (trimmed.includes('#include') || /^(int|void|char|float|double)\s+\w+\s*\(/m.test(trimmed)) {
        if (trimmed.includes('std::') || trimmed.includes('cout') || trimmed.includes('namespace')) {
            return 'cpp';
        }
        return 'c';
    }

    // C# detection
    if (/^(using|namespace)\s+\w+/m.test(trimmed) && trimmed.includes('class')) {
        return 'csharp';
    }

    // Go detection
    if (trimmed.includes('package main') || /^func\s+\w+\s*\(/m.test(trimmed)) {
        return 'go';
    }

    // Rust detection
    if (/^(fn|pub|use|mod|impl|trait)\s+/m.test(trimmed) || trimmed.includes('println!')) {
        return 'rust';
    }

    // PHP detection
    if (trimmed.startsWith('<?php') || trimmed.includes('<?php')) {
        return 'php';
    }

    // Ruby detection
    if (/^(def|class|module|require|puts|end)\s+/m.test(trimmed)) {
        return 'ruby';
    }

    // Shell script detection
    if (trimmed.startsWith('#!') || /^(echo|cd|ls|mkdir|rm|export)\s+/m.test(trimmed)) {
        return 'shell';
    }

    // SQL detection
    if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+/mi.test(trimmed)) {
        return 'sql';
    }

    // Markdown detection
    if (/^#{1,6}\s+/m.test(trimmed) || trimmed.includes('```') || /^\*\*.*\*\*$/m.test(trimmed)) {
        return 'markdown';
    }

    // YAML detection
    if (/^[\w-]+:\s*$/m.test(trimmed) && !trimmed.includes('{') && !trimmed.includes(';')) {
        return 'yaml';
    }

    return null; // Could not detect
}
