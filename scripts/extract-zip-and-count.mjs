import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UPLOAD_DIR = path.resolve(process.cwd(), 'upload');

function errorText(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === 'string') return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

function isRealZipPath(filePath) {
	if (path.extname(filePath).toLowerCase() !== '.zip') return false;
	const base = path.basename(filePath);
	if (base.startsWith('._')) return false;
	if (filePath.includes('/__MACOSX/') || filePath.includes('\\__MACOSX\\')) return false;
	return true;
}

async function listFilesRecursive(dirPath) {
	const out = [];
	const stack = [dirPath];
	while (stack.length > 0) {
		const current = stack.pop();
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (entry.isFile()) out.push(fullPath);
		}
	}
	return out;
}

async function listDirsRecursive(dirPath) {
	const out = [];
	const stack = [dirPath];
	while (stack.length > 0) {
		const current = stack.pop();
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const fullPath = path.join(current, entry.name);
			out.push(fullPath);
			stack.push(fullPath);
		}
	}
	return out;
}

function buildFallbackDirPath(preferredDir) {
	const parent = path.dirname(preferredDir);
	const base = path.basename(preferredDir);
	return path.join(parent, `${base}_${Date.now()}`);
}

async function prepareEmptyDir(preferredDir) {
	try {
		await rm(preferredDir, { recursive: true, force: true });
		await mkdir(preferredDir, { recursive: true });
		return preferredDir;
	} catch (err) {
		const fallbackDir = buildFallbackDirPath(preferredDir);
		await mkdir(fallbackDir, { recursive: true });
		console.log(
			`[zip:extract] cannot reuse output dir (${preferredDir}); using fallback: ${fallbackDir}`
		);
		console.log(`[zip:extract] reason: ${err instanceof Error ? err.message : String(err)}`);
		return fallbackDir;
	}
}

async function unzipToDir(zipPath, preferredOutputDir) {
	const outputDir = await prepareEmptyDir(preferredOutputDir);
	try {
		// Force C locale so unzip is less likely to fail on odd filename byte sequences.
		await execFileAsync('unzip', ['-o', zipPath, '-d', outputDir], {
			env: { ...process.env, LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C' }
		});
	} catch (unzipErr) {
		const unzipMsg = errorText(unzipErr);
		console.log('[zip:extract] unzip failed, retrying with ditto...');
		console.log(`[zip:extract] unzip reason: ${unzipMsg}`);
		try {
			// macOS-native extractor; handles some filename-encoding cases better.
			await execFileAsync('ditto', ['-x', '-k', zipPath, outputDir]);
			console.log('[zip:extract] ditto fallback succeeded.');
		} catch (dittoErr) {
			const dittoMsg = errorText(dittoErr);
			throw new Error(`Both unzip and ditto failed.\n- unzip: ${unzipMsg}\n- ditto: ${dittoMsg}`);
		}
	}
	return outputDir;
}

function isMacMetadataFile(filePath) {
	const base = path.basename(filePath);
	return base === '.DS_Store' || base.startsWith('._');
}

async function cleanupMacArtifacts(rootOutputDir) {
	let removedFiles = 0;
	let removedDirs = 0;

	const files = await listFilesRecursive(rootOutputDir);
	for (const filePath of files) {
		if (!isMacMetadataFile(filePath)) continue;
		await rm(filePath, { force: true });
		removedFiles += 1;
	}

	const dirs = await listDirsRecursive(rootOutputDir);
	// Remove deepest first to avoid parent-before-child issues.
	dirs.sort((a, b) => b.length - a.length);
	for (const dirPath of dirs) {
		if (path.basename(dirPath) !== '__MACOSX') continue;
		await rm(dirPath, { recursive: true, force: true });
		removedDirs += 1;
	}

	return { removedFiles, removedDirs };
}

async function makeDirectoriesWritable(rootDir) {
	const dirs = [rootDir, ...(await listDirsRecursive(rootDir))];
	let updated = 0;
	for (const dirPath of dirs) {
		try {
			await chmod(dirPath, 0o755);
			updated += 1;
		} catch {
			// Best effort only; continue.
		}
	}
	return updated;
}

async function resolveZipFromArgs(zipArg) {
	const cleanArg = zipArg?.trim();
	// If user passed an explicit path, honor it.
	if (cleanArg) {
		const directPath = path.resolve(cleanArg);
		const directInfo = await stat(directPath).catch(() => null);
		if (directInfo?.isFile()) return directPath;

		// If only a filename is passed, try upload folder.
		const uploadPath = path.resolve(UPLOAD_DIR, cleanArg);
		const uploadInfo = await stat(uploadPath).catch(() => null);
		if (uploadInfo?.isFile()) return uploadPath;

		// Fallback: recursive/case-insensitive basename match inside upload folder.
		const uploadFiles = await listFilesRecursive(UPLOAD_DIR).catch(() => []);
		const uploadZips = uploadFiles.filter((file) => isRealZipPath(file));
		const normalizedArg = cleanArg.toLowerCase();
		const normalizedArgZip = normalizedArg.endsWith('.zip') ? normalizedArg : `${normalizedArg}.zip`;
		const matches = uploadZips.filter((file) => {
			const base = path.basename(file).toLowerCase();
			return base === normalizedArg || base === normalizedArgZip;
		});
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			const withMtime = await Promise.all(
				matches.map(async (zipPath) => {
					const info = await stat(zipPath);
					return { zipPath, mtimeMs: info.mtimeMs };
				})
			);
			withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
			console.log(
				`[zip:extract] multiple matches for "${cleanArg}", using newest: ${withMtime[0].zipPath}`
			);
			return withMtime[0].zipPath;
		}

		const available = Array.from(new Set(uploadZips.map((file) => path.basename(file)))).slice(0, 12);
		throw new Error(
			`zip file not found: ${cleanArg}. Available zip files in upload: ${available.join(', ') || '(none)'}`
		);
	}

	// No arg: auto-pick newest zip from upload folder.
	const uploadStat = await stat(UPLOAD_DIR).catch(() => null);
	if (!uploadStat?.isDirectory()) {
		throw new Error(`upload folder not found: ${UPLOAD_DIR}`);
	}
	const files = await listFilesRecursive(UPLOAD_DIR);
	const zips = files.filter((file) => isRealZipPath(file));
	if (zips.length === 0) {
		throw new Error(`no .zip files found in upload folder: ${UPLOAD_DIR}`);
	}
	const withMtime = await Promise.all(
		zips.map(async (zipPath) => {
			const info = await stat(zipPath);
			return { zipPath, mtimeMs: info.mtimeMs };
		})
	);
	withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return withMtime[0].zipPath;
}

async function extractNestedZips(rootOutputDir) {
	const processed = new Set();
	let nestedZipCount = 0;
	let nestedZipFailures = 0;

	while (true) {
		await makeDirectoriesWritable(rootOutputDir);
		const files = await listFilesRecursive(rootOutputDir);
		const zips = files.filter((file) => isRealZipPath(file));
		const pending = zips.filter((zipPath) => !processed.has(zipPath));
		if (pending.length === 0) break;

		for (const zipPath of pending) {
			processed.add(zipPath);
			const base = path.basename(zipPath, '.zip');
			const parent = path.dirname(zipPath);
			const nestedOutputDir = path.join(parent, `${base}_extracted`);
			try {
				const resolvedNestedOutputDir = await unzipToDir(zipPath, nestedOutputDir);
				nestedZipCount += 1;
				console.log(`[zip:extract] nested zip extracted: ${zipPath} -> ${resolvedNestedOutputDir}`);
			} catch (err) {
				nestedZipFailures += 1;
				console.log(`[zip:extract] nested zip skipped (failed to extract): ${zipPath}`);
				console.log(`[zip:extract] reason: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	return { nestedZipCount, nestedZipFailures };
}

async function main() {
	const [, , zipArg, outputArg] = process.argv;
	const zipPath = await resolveZipFromArgs(zipArg);
	if (path.extname(zipPath).toLowerCase() !== '.zip') {
		console.error(`[zip:extract] input is not a .zip file: ${zipPath}`);
		process.exit(1);
	}

	const defaultOutput = path.join(path.dirname(zipPath), `${path.basename(zipPath, '.zip')}_extracted`);
	let outputDir = path.resolve(outputArg ?? defaultOutput);

	console.log(`[zip:extract] source zip: ${zipPath}`);
	console.log(`[zip:extract] requested output dir: ${outputDir}`);

	outputDir = await unzipToDir(zipPath, outputDir);
	console.log(`[zip:extract] output dir: ${outputDir}`);
	console.log('[zip:extract] root zip extracted.');
	const writableDirsUpdated = await makeDirectoriesWritable(outputDir);
	console.log(`[zip:extract] writable directory normalization: ${writableDirsUpdated} dirs updated`);

	const { nestedZipCount, nestedZipFailures } = await extractNestedZips(outputDir);
	const { removedFiles, removedDirs } = await cleanupMacArtifacts(outputDir);
	const allFiles = await listFilesRecursive(outputDir);
	const allDirs = await listDirsRecursive(outputDir);
	const zipFiles = allFiles.filter((file) => path.extname(file).toLowerCase() === '.zip');
	const nonZipFiles = allFiles.filter((file) => path.extname(file).toLowerCase() !== '.zip');

	console.log('[zip:extract] summary:');
	console.log(`- nested zips extracted: ${nestedZipCount}`);
	console.log(`- nested zips failed/skipped: ${nestedZipFailures}`);
	console.log(`- mac metadata files removed: ${removedFiles}`);
	console.log(`- __MACOSX folders removed: ${removedDirs}`);
	console.log(`- total folders found: ${allDirs.length}`);
	console.log(`- total files found: ${allFiles.length}`);
	console.log(`- non-zip files: ${nonZipFiles.length}`);
	console.log(`- zip files still present: ${zipFiles.length}`);
}

main().catch((err) => {
	console.error('[zip:extract] failed:', err);
	process.exit(1);
});
