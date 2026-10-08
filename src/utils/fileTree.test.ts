import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./fileOperations', () => ({ openFolderDialog: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { buildFileTree, normalizeTreePath, readTreeLevel } from './fileTree';

const file = (path: string, name: string) => ({ name, path, is_directory: false });
const dir = (path: string, name: string) => ({ name, path, is_directory: true });

describe('Windows network folders', () => {
    it('keeps the double slash of a UNC path', () => {
        expect(normalizeTreePath('\\\\?\\UNC\\server\\share\\a.txt')).toBe('//server/share/a.txt');
        expect(normalizeTreePath('\\\\?\\C:\\work\\a.txt')).toBe('C:/work/a.txt');
        expect(normalizeTreePath('\\\\server\\share\\a.txt')).toBe('//server/share/a.txt');
    });

    it('lists the contents of a \\\\server\\share folder', () => {
        const tree = buildFileTree(
            [
                dir('\\\\server\\share\\docs', 'docs'),
                file('\\\\?\\UNC\\server\\share\\docs\\plan.md', 'plan.md'),
                file('\\\\server\\share\\readme.txt', 'readme.txt'),
            ],
            '\\\\server\\share',
        );
        expect(tree.map(n => n.name)).toEqual(['docs', 'readme.txt']);
        expect(tree[0].children?.map(n => n.path)).toEqual(['//server/share/docs/plan.md']);
    });
});

describe('symbolic links left out of the explorer', () => {
    it('says how many links a folder has instead of hiding them silently', async () => {
        vi.mocked(invoke).mockResolvedValueOnce({
            entries: [file('/work/a.txt', 'a.txt')], truncated: false, hiddenLinks: 3,
        });
        const nodes = await readTreeLevel('/work');
        expect(nodes.map(n => n.name)).toEqual(['a.txt', '3 symbolic links not shown']);
        expect(nodes[1].placeholder).toBe(true);
    });

    it('adds no note when there are none', async () => {
        vi.mocked(invoke).mockResolvedValueOnce({
            entries: [file('/work/a.txt', 'a.txt')], truncated: false, hiddenLinks: 0,
        });
        expect((await readTreeLevel('/work')).map(n => n.name)).toEqual(['a.txt']);
    });
});
