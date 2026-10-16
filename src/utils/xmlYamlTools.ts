/**
 * XML and YAML Formatting Tools
 */

import { parseDocument, visit, type Document } from 'yaml';

// Guards against pathological input freezing the UI thread during formatting.
const MAX_FORMAT_INPUT_CHARS = 20_000_000; // ~20M characters
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

function hasInternalDtdSubset(text: string): boolean {
    const start = text.search(/<!DOCTYPE\b/i);
    if (start < 0) return false;
    let quote: '"' | "'" | null = null;
    for (let index = start + 9; index < text.length; index += 1) {
        const character = text[index];
        if (quote) {
            if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '[') {
            return true;
        } else if (character === '>') {
            return false;
        }
    }
    return false;
}

function preservesXmlSpace(element: Element): boolean {
    let current: Element | null = element;
    while (current) {
        const value = current.getAttributeNS(XML_NAMESPACE, 'space');
        if (value === 'preserve') return true;
        if (value === 'default') return false;
        current = current.parentElement;
    }
    return false;
}

function parseXmlDocument(text: string): XMLDocument {
    const parser = new DOMParser();
    const documentNode = parser.parseFromString(text, 'application/xml');
    const parserError = documentNode.querySelector('parsererror');
    if (parserError) {
        throw new Error(parserError.textContent || 'XML parsing error');
    }
    return documentNode;
}

/**
 * Produce a semantic signature for round-trip verification. Formatting-only
 * whitespace inside element-only content is ignored, while every text node in
 * mixed content, CDATA, comments, processing instructions, namespaces, and
 * attributes remains significant.
 */
function xmlSemanticSignature(node: Node): unknown {
    switch (node.nodeType) {
        case Node.DOCUMENT_NODE:
            return ['document', ...Array.from(node.childNodes)
                .filter(child => child.nodeType !== Node.TEXT_NODE || Boolean(child.nodeValue?.trim()))
                .map(xmlSemanticSignature)];
        case Node.DOCUMENT_TYPE_NODE: {
            const doctype = node as DocumentType;
            return ['doctype', doctype.name, doctype.publicId, doctype.systemId];
        }
        case Node.ELEMENT_NODE: {
            const element = node as Element;
            const children = Array.from(element.childNodes);
            const hasMixedContent = preservesXmlSpace(element) || children.some(child =>
                child.nodeType === Node.CDATA_SECTION_NODE
                || (child.nodeType === Node.TEXT_NODE && Boolean(child.nodeValue?.trim()))
            );
            const attributes = Array.from(element.attributes)
                .map(attribute => [
                    attribute.namespaceURI ?? '',
                    attribute.name,
                    attribute.value,
                ])
                .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
            const semanticChildren = children
                .filter(child => hasMixedContent
                    || child.nodeType !== Node.TEXT_NODE
                    || Boolean(child.nodeValue?.trim()))
                .map(xmlSemanticSignature);
            return [
                'element',
                element.namespaceURI ?? '',
                element.nodeName,
                attributes,
                semanticChildren,
            ];
        }
        case Node.TEXT_NODE:
            return ['text', node.nodeValue ?? ''];
        case Node.CDATA_SECTION_NODE:
            return ['cdata', node.nodeValue ?? ''];
        case Node.COMMENT_NODE:
            return ['comment', node.nodeValue ?? ''];
        case Node.PROCESSING_INSTRUCTION_NODE:
            return ['processing-instruction', node.nodeName, node.nodeValue ?? ''];
        default:
            return ['node', node.nodeType, node.nodeName, node.nodeValue ?? ''];
    }
}

/**
 * Format XML with proper indentation
 */
/** Stands in for the "&" of a reference while the document is re-serialized. */
const REFERENCE_MARK = '\uE000';
const XML_REFERENCE = /&(?=#[0-9]+;|#x[0-9a-fA-F]+;|[A-Za-z_][\w.-]*;)/g;

export function formatXml(text: string, indent: number = 2): string {
    if (text.length > MAX_FORMAT_INPUT_CHARS) {
        throw new Error('XML input is too large to format.');
    }
    try {
        if (hasInternalDtdSubset(text)) {
            throw new Error('XML documents with an internal DTD subset are left unchanged because browser serialization cannot preserve that subset safely');
        }
        const declaration = /^\uFEFF?\s*(<\?xml(?=\s|\?>)[\s\S]*?\?>)/i.exec(text)?.[1];
        const originalSignature = JSON.stringify(xmlSemanticSignature(parseXmlDocument(text)));
        // Entity and character references (&quot;, &#169;, &#xA9; ...) are
        // kept as written: the serializer would otherwise turn them into the
        // characters they stand for. Their "&" travels through the round trip
        // as a private-use character, which is then put back.
        const protect = !text.includes(REFERENCE_MARK);
        const documentNode = parseXmlDocument(protect ? text.replace(XML_REFERENCE, REFERENCE_MARK) : text);

        const indentText = ' '.repeat(Math.max(1, indent));
        const formatElement = (element: Element, depth: number): void => {
            const children = Array.from(element.childNodes);
            const hasMixedContent = preservesXmlSpace(element) || children.some(node =>
                node.nodeType === Node.CDATA_SECTION_NODE
                || (node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').trim().length > 0)
            );

            for (const child of children) {
                if (child.nodeType === Node.ELEMENT_NODE) {
                    formatElement(child as Element, depth + 1);
                }
            }

            // Adding indentation inside mixed content changes text semantics.
            // Leave those nodes byte-for-byte as parsed and only pretty-print
            // elements whose children are markup/whitespace only.
            if (hasMixedContent) return;

            for (const child of Array.from(element.childNodes)) {
                if (child.nodeType === Node.TEXT_NODE && !(child.nodeValue ?? '').trim()) {
                    element.removeChild(child);
                }
            }

            const structuralChildren = Array.from(element.childNodes);
            if (structuralChildren.length === 0) return;
            const childPadding = `\n${indentText.repeat(depth + 1)}`;
            for (const child of structuralChildren) {
                element.insertBefore(documentNode.createTextNode(childPadding), child);
            }
            element.appendChild(documentNode.createTextNode(`\n${indentText.repeat(depth)}`));
        };

        const root = documentNode.documentElement;
        formatElement(root, 0);
        // One line per top-level node: comments and processing instructions
        // before the root used to be joined onto the root element's line.
        const serializer = new XMLSerializer();
        const serialized = Array.from(documentNode.childNodes)
            .map(node => serializer.serializeToString(node).trim())
            .filter(Boolean)
            .join('\n');
        const restored = protect ? serialized.split(REFERENCE_MARK).join('&') : serialized;
        const output = declaration ? `${declaration}\n${restored}` : restored;
        const outputSignature = JSON.stringify(xmlSemanticSignature(parseXmlDocument(output)));
        if (outputSignature !== originalSignature) {
            throw new Error('Formatter round-trip changed the XML document semantics');
        }
        return output;
    } catch (error) {
        throw new Error(`Failed to format XML: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

const YAML_PARSE_OPTIONS = { intAsBigInt: true } as const;

/** Source spans of plain scalars that are not strings (numbers, booleans,
 *  null): the values whose spelling a serializer may change. */
function plainValueSpans(doc: Document.Parsed): [number, number][] {
    const spans: [number, number][] = [];
    visit(doc, {
        Scalar(_key, node) {
            if (node.type === 'PLAIN' && typeof node.value !== 'string' && node.range) {
                spans.push([node.range[0], node.range[1]]);
            }
        },
    });
    return spans;
}

/**
 * Format YAML with proper indentation.
 *
 * Uses the `yaml` package's document model, which round-trips comments and
 * normalizes indentation/spacing without altering the document's structure.
 *
 * Values are kept exactly as written. The serializer would otherwise rewrite
 * them: `0755` became `755` (a different number to YAML 1.1 tools such as
 * Ansible and PyYAML), big integers lost precision, `0x1F` became `0x1f` and
 * long values were folded. Integers are parsed as BigInt, lines are never
 * folded, and every number/boolean/null is restored to its original spelling.
 * If that cannot be done safely, formatting is refused and the document is
 * left unchanged.
 */
export function formatYaml(text: string, indent: number = 2): string {
    if (text.length > MAX_FORMAT_INPUT_CHARS) {
        throw new Error('YAML input is too large to format.');
    }
    try {
        const doc = parseDocument(text, YAML_PARSE_OPTIONS);
        // Surface genuine syntax errors rather than emitting partial output.
        if (doc.errors.length > 0) {
            throw new Error(doc.errors[0].message);
        }
        const originals = plainValueSpans(doc).map(([start, end]) => text.slice(start, end));

        let out = doc.toString({ indent, lineWidth: 0 });
        const formattedSpans = plainValueSpans(parseDocument(out, YAML_PARSE_OPTIONS));
        if (formattedSpans.length !== originals.length) {
            throw new Error('formatting would change some values, so the document was left unchanged');
        }
        for (let i = formattedSpans.length - 1; i >= 0; i--) {
            const [start, end] = formattedSpans[i];
            out = out.slice(0, start) + originals[i] + out.slice(end);
        }

        const check = parseDocument(out, YAML_PARSE_OPTIONS);
        const kept = plainValueSpans(check).map(([start, end]) => out.slice(start, end));
        if (check.errors.length > 0 || kept.join('\u0000') !== originals.join('\u0000')) {
            throw new Error('formatting would change some values, so the document was left unchanged');
        }
        return out.trimEnd();
    } catch (error) {
        throw new Error(`Failed to format YAML: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Validate XML (basic check)
 */
export function validateXml(text: string): { valid: boolean; error?: string } {
    try {
        parseXmlDocument(text);
        return { valid: true };
    } catch (error) {
        return {
            valid: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Check if text is valid XML
 */
export function isValidXml(text: string): boolean {
    return validateXml(text).valid;
}
