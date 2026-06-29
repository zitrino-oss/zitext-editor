/**
 * Monaco Editor Type Definitions
 * 
 * Re-exports commonly used Monaco Editor types for easier imports
 * and better type safety throughout the application.
 */

import type { editor } from 'monaco-editor';

/** Monaco standalone code editor instance */
export type MonacoEditor = editor.IStandaloneCodeEditor;

/** Monaco text model */
export type MonacoModel = editor.ITextModel;

/** Monaco find match result */
export type MonacoFindMatch = editor.FindMatch;

/** Monaco editor options */
export type MonacoEditorOptions = editor.IStandaloneEditorConstructionOptions;
