/**
 * JSON Type Definitions
 * 
 * Type-safe definitions for working with JSON data structures.
 * Prevents the use of 'any' types when handling JSON.
 */

/** JSON primitive values */
export type JsonPrimitive = string | number | boolean | null;

/** JSON object type */
export interface JsonObject {
    [key: string]: JsonValue;
}

/** JSON array type */
export type JsonArray = JsonValue[];

/** Any valid JSON value */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * Type guard to check if a value is a JSON object
 */
export function isJsonObject(value: JsonValue): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard to check if a value is a JSON array
 */
export function isJsonArray(value: JsonValue): value is JsonArray {
    return Array.isArray(value);
}
