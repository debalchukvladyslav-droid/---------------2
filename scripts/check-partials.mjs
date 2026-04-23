import { readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'index.html');
const partialAttrPattern = /data-partial\s*=\s*["']([^"']+)["']/g;
const idPattern = /\sid\s*=\s*["']([^"']+)["']/g;

async function readText(filePath) {
    return readFile(filePath, 'utf8');
}

function normalizePartialPath(partialPath) {
    return partialPath.replaceAll('/', path.sep);
}

async function collectHtmlWithPartials(html, seen = new Set()) {
    let combined = html;
    const partials = [...html.matchAll(partialAttrPattern)].map((match) => match[1]);

    for (const partial of partials) {
        if (seen.has(partial)) continue;
        seen.add(partial);

        const fullPath = path.join(rootDir, normalizePartialPath(partial));
        const partialHtml = await readText(fullPath);
        combined += `\n${await collectHtmlWithPartials(partialHtml, seen)}`;
    }

    return combined;
}

function findDuplicateIds(html) {
    const counts = new Map();
    for (const match of html.matchAll(idPattern)) {
        const id = match[1];
        counts.set(id, (counts.get(id) || 0) + 1);
    }

    return [...counts.entries()]
        .filter(([, count]) => count > 1)
        .sort(([a], [b]) => a.localeCompare(b));
}

async function main() {
    const indexHtml = await readText(indexPath);
    const partials = [...indexHtml.matchAll(partialAttrPattern)].map((match) => match[1]);

    if (!partials.length) {
        throw new Error('No partial placeholders found in index.html');
    }

    for (const partial of partials) {
        const fullPath = path.join(rootDir, normalizePartialPath(partial));
        await readText(fullPath);
    }

    const combinedHtml = await collectHtmlWithPartials(indexHtml);
    const duplicateIds = findDuplicateIds(combinedHtml);

    if (duplicateIds.length) {
        const details = duplicateIds.map(([id, count]) => `- ${id}: ${count}`).join('\n');
        throw new Error(`Duplicate id attributes found:\n${details}`);
    }

    console.log(`Partials OK: ${partials.length} placeholders checked.`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
