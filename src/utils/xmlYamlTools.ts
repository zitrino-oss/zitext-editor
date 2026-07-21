/**
 * XML and YAML Formatting Tools
 */

import { parseDocument } from 'yaml';

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
export function formatXml(text: string, indent: number = 2): string {
    if (text.length > MAX_FORMAT_INPUT_CHARS) {
        throw new Error('XML input is too large to format.');
    }
    try {
        if (hasInternalDtdSubset(text)) {
            throw new Error('XML documents with an internal DTD subset are left unchanged because browser serialization cannot preserve that subset safely');
        }
        const declaration = /^\uFEFF?\s*(<\?xml(?=\s|\?>)[\s\S]*?\?>)/i.exec(text)?.[1];
        const documentNode = parseXmlDocument(text);
        const originalSignature = JSON.stringify(xmlSemanticSignature(documentNode));

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
        const serialized = new XMLSerializer().serializeToString(documentNode).trim();
        const output = declaration ? `${declaration}\n${serialized}` : serialized;
        const outputSignature = JSON.stringify(xmlSemanticSignature(parseXmlDocument(output)));
        if (outputSignature !== originalSignature) {
            throw new Error('Formatter round-trip changed the XML document semantics');
        }
        return output;
    } catch (error) {
        throw new Error(`Failed to format XML: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Format YAML with proper indentation.
 *
 * Uses the `yaml` package's document model, which round-trips comments and
 * normalizes indentation/spacing without altering the document's structure or
 * values. This replaces the previous hand-rolled line reformatter, which could
 * silently corrupt valid YAML (e.g. treating `#` inside a quoted value as a
 * comment, or splitting on a `:` inside a quoted string).
 */
export function formatYaml(text: string, indent: number = 2): string {
    if (text.length > MAX_FORMAT_INPUT_CHARS) {
        throw new Error('YAML input is too large to format.');
    }
    try {
        const doc = parseDocument(text);
        // Surface genuine syntax errors rather than emitting partial output.
        if (doc.errors.length > 0) {
            throw new Error(doc.errors[0].message);
        }
        return doc.toString({ indent }).trimEnd();
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
