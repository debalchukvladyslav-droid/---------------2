import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const ignoredDirs = new Set(['.git', '.vercel', 'node_modules']);
const textExtensions = new Set(['.html', '.css', '.js', '.mjs', '.json']);

function toPosix(value) {
    return value.split(path.sep).join('/');
}

function fromPosix(value) {
    return value.split('/').join(path.sep);
}

async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walk(fullPath));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files;
}

async function readText(relativePath) {
    return readFile(path.join(rootDir, fromPosix(relativePath)), 'utf8');
}

async function exists(relativePath) {
    try {
        const info = await stat(path.join(rootDir, fromPosix(relativePath)));
        return info.isFile();
    } catch {
        return false;
    }
}

function matchesAll(source, pattern) {
    return [...source.matchAll(pattern)].map((match) => match[1]);
}

function resolveRelativeImport(owner, specifier) {
    if (!specifier.startsWith('.')) return null;

    const ownerDir = path.posix.dirname(owner);
    const normalized = path.posix.normalize(path.posix.join(ownerDir, specifier));
    if (path.posix.extname(normalized)) return normalized;
    return `${normalized}.js`;
}

function groupFiles(files) {
    const groups = {
        css: [],
        js: [],
        api: [],
        partials: [],
        database: [],
        tests: [],
        config: [],
        other: [],
    };

    for (const file of files) {
        if (file.startsWith('css/')) groups.css.push(file);
        else if (file.startsWith('js/')) groups.js.push(file);
        else if (file.startsWith('api/')) groups.api.push(file);
        else if (file.startsWith('partials/')) groups.partials.push(file);
        else if (file.startsWith('database/') || file.startsWith('supabase/')) groups.database.push(file);
        else if (file.startsWith('tests/')) groups.tests.push(file);
        else if (['package.json', 'vercel.json', 'config.example.js', 'config.js'].includes(file)) groups.config.push(file);
        else groups.other.push(file);
    }

    return groups;
}

async function collectPartialTree(entryHtml) {
    const seen = new Set();
    const order = [];

    async function visit(html, owner) {
        const partials = matchesAll(html, /data-partial\s*=\s*["']([^"']+)["']/g);
        for (const partial of partials) {
            const normalized = path.posix.normalize(partial);
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            order.push({ owner, partial: normalized });

            if (await exists(normalized)) {
                await visit(await readText(normalized), normalized);
            }
        }
    }

    await visit(entryHtml, 'index.html');
    return order;
}

async function collectImportGraph(jsFiles) {
    const fileSet = new Set(jsFiles);
    const graph = new Map();
    const missing = [];

    for (const file of jsFiles) {
        const source = await readText(file);
        const specs = [
            ...matchesAll(source, /import\s+(?:[^'"()]+?\s+from\s+)?["']([^"']+)["']/g),
            ...matchesAll(source, /import\(\s*["']([^"']+)["']\s*\)/g),
        ];
        const localImports = [];

        for (const spec of specs) {
            const resolved = resolveRelativeImport(file, spec);
            if (!resolved) continue;
            localImports.push(resolved);
            if (!fileSet.has(resolved)) missing.push({ owner: file, target: resolved });
        }

        graph.set(file, localImports);
    }

    return { graph, missing };
}

function collectReachableScripts(entryScripts, graph) {
    const reachable = new Set();
    const stack = [...entryScripts];

    while (stack.length) {
        const file = stack.pop();
        if (reachable.has(file)) continue;
        reachable.add(file);
        for (const child of graph.get(file) || []) stack.push(child);
    }

    return reachable;
}

async function collectTodos(files) {
    const todos = [];

    for (const file of files) {
        if (file === 'scripts/audit-site.mjs') continue;

        const ext = path.posix.extname(file);
        if (!textExtensions.has(ext)) continue;

        const lines = (await readText(file)).split(/\r?\n/);
        lines.forEach((line, index) => {
            if (/\b(TODO|FIXME|HACK)\b/i.test(line)) {
                todos.push({ file, line: index + 1, text: line.trim().slice(0, 120) });
            }
        });
    }

    return todos;
}

function printList(title, rows, formatter = (item) => item) {
    console.log(`\n${title}`);
    if (!rows.length) {
        console.log('  none');
        return;
    }
    for (const row of rows) console.log(`  - ${formatter(row)}`);
}

async function main() {
    const files = (await walk(rootDir))
        .map((file) => toPosix(path.relative(rootDir, file)))
        .sort((a, b) => a.localeCompare(b));
    const groups = groupFiles(files);

    const indexHtml = await readText('index.html');
    const linkedCss = matchesAll(indexHtml, /<link[^>]+href=["']([^"']+\.css)["']/g)
        .filter((href) => !href.startsWith('http'))
        .map((href) => path.posix.normalize(href));
    const entryScripts = matchesAll(indexHtml, /<script[^>]+src=["']([^"']+\.js)["']/g)
        .filter((src) => !src.startsWith('http'))
        .map((src) => path.posix.normalize(src));
    const partialTree = await collectPartialTree(indexHtml);

    const { graph, missing: missingImports } = await collectImportGraph(groups.js);
    const reachableScripts = collectReachableScripts(entryScripts.filter((file) => groups.js.includes(file)), graph);
    const unusedCss = groups.css.filter((file) => !linkedCss.includes(file));
    const unreferencedPartials = groups.partials
        .filter((file) => file.endsWith('.html'))
        .filter((file) => !partialTree.some((entry) => entry.partial === file));

    const vercelConfig = JSON.parse(await readText('vercel.json'));
    const rewrites = Array.isArray(vercelConfig.rewrites) ? vercelConfig.rewrites : [];
    const apiEndpoints = groups.api
        .filter((file) => file.endsWith('.js'))
        .filter((file) => !path.posix.basename(file).startsWith('_'))
        .map((file) => `/${file.replace(/\.js$/, '')}`)
        .sort((a, b) => a.localeCompare(b));
    const todos = await collectTodos(files);

    const missingLinkedCss = [];
    for (const file of linkedCss) {
        if (!await exists(file)) missingLinkedCss.push(file);
    }

    const missingEntryScripts = [];
    for (const file of entryScripts) {
        if (!await exists(file)) missingEntryScripts.push(file);
    }

    const missingPartials = [];
    for (const item of partialTree) {
        if (!await exists(item.partial)) missingPartials.push(item);
    }

    console.log('Site audit');
    console.log(`Root: ${rootDir}`);
    console.log(`Files tracked: ${files.length}`);

    printList('Groups', Object.entries(groups), ([name, values]) => `${name}: ${values.length}`);
    printList('Index CSS order', linkedCss);
    printList('Index module entries', entryScripts);
    printList('Vercel app routes', rewrites.map((route) => `${route.source} -> ${route.destination}`));
    printList('API endpoints', apiEndpoints);
    printList('Partials in render order', partialTree, (item) => `${item.partial} (${item.owner})`);
    printList('JS modules reachable from index', [...reachableScripts].sort((a, b) => a.localeCompare(b)));
    printList('CSS files not linked by index', unusedCss);
    printList('Partials not mounted by index tree', unreferencedPartials);
    printList('TODO/FIXME/HACK markers', todos, (item) => `${item.file}:${item.line} ${item.text}`);

    const blockers = [
        ...missingLinkedCss.map((file) => `Missing linked CSS: ${file}`),
        ...missingEntryScripts.map((file) => `Missing entry script: ${file}`),
        ...missingPartials.map((item) => `Missing partial: ${item.partial} referenced by ${item.owner}`),
        ...missingImports.map((item) => `Missing JS import: ${item.target} referenced by ${item.owner}`),
    ];

    printList('Blocking issues', blockers);

    if (blockers.length) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
