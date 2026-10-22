import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, statfs } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import { env } from '../config/env.js'

export interface ObjectStorage {
	write(input: Readable, key: string, expectedBytes: bigint): Promise<string>
	commit(stagedKey: string, key: string): Promise<void>
	read(key: string): Promise<Readable>
	copy(
		source: string,
		target: string,
		expectedBytes: bigint,
		expectedChecksum: string,
	): Promise<void>
	delete(key: string): Promise<void>
	exists(key: string): Promise<boolean>
}

const keyPattern = /^(?:objects\/[1-9]\d*\/[0-9a-f-]{36}|staging\/[0-9a-f-]{36})$/

export class LocalObjectStorage implements ObjectStorage {
	constructor(private readonly root: string) {}

	private path(key: string): string {
		if (!keyPattern.test(key)) throw new Error('Invalid storage key')
		return join(this.root, key)
	}

	private async check(path: string, directory: boolean): Promise<void> {
		const info = await lstat(path)
		if (info.isSymbolicLink()) throw new Error('Storage symbolic links are forbidden')
		if (directory ? !info.isDirectory() : !info.isFile())
			throw new Error('Invalid storage entry type')
		if (info.uid !== process.geteuid?.())
			throw new Error('Storage ownership must match the API user')
		if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600))
			throw new Error('Unsafe storage permissions; use 0700 directories and 0600 files')
	}

	private async directory(path: string): Promise<void> {
		try {
			await mkdir(path, { mode: 0o700 })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
		await this.check(path, true)
	}

	private async checkParents(key: string, create = false): Promise<void> {
		await this.check(this.root, true)
		let current = this.root
		for (const part of relative(this.root, dirname(this.path(key)))
			.split(sep)
			.filter(Boolean)) {
			current = join(current, part)
			if (create) await this.directory(current)
			else await this.check(current, true)
		}
	}

	async init(): Promise<void> {
		if (env.NODE_ENV === 'production' && process.geteuid?.() === 0)
			throw new Error('The production API must not run as root')
		// Reject symlink ancestors before mkdir can follow them.
		let current = parse(resolve(this.root)).root
		for (const part of resolve(this.root).slice(current.length).split(sep).filter(Boolean)) {
			current = join(current, part)
			try {
				if ((await lstat(current)).isSymbolicLink())
					throw new Error('Storage symbolic links are forbidden')
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
				await mkdir(current, { mode: 0o700 })
			}
		}
		await this.check(this.root, true)
		await this.directory(join(this.root, 'staging'))
		await this.directory(join(this.root, 'objects'))
	}

	async capacity() {
		await this.check(this.root, true)
		const info = await statfs(this.root, { bigint: true })
		return {
			totalBytes: info.blocks * info.bsize,
			availableBytes: info.bavail * info.bsize,
			freeInodes: info.ffree,
			totalInodes: info.files,
		}
	}

	async write(input: Readable, key: string, expectedBytes: bigint): Promise<string> {
		await this.checkParents(key, true)
		const destination = this.path(key)
		const handle = await open(
			destination,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		)
		const hash = createHash('sha256')
		let actual = 0n
		const verifier = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				actual += BigInt(chunk.length)
				if (actual > expectedBytes) return callback(new Error('Upload exceeds declared size'))
				hash.update(chunk)
				callback(null, chunk)
			},
		})
		try {
			await pipeline(input, verifier, handle.createWriteStream())
			if (actual !== expectedBytes) throw new Error('Upload size differs from declared size')
			const file = await open(destination, 'r')
			try {
				await file.sync()
			} finally {
				await file.close()
			}
			return hash.digest('hex')
		} catch (error) {
			await rm(destination, { force: true })
			throw error
		}
	}

	async commit(stagedKey: string, key: string): Promise<void> {
		const destination = this.path(key)
		await this.checkParents(stagedKey)
		await this.check(this.path(stagedKey), false)
		await this.checkParents(key, true)
		await rename(this.path(stagedKey), destination)
		const directory = await open(dirname(destination), 'r')
		try {
			await directory.sync()
		} finally {
			await directory.close()
		}
	}

	async read(key: string): Promise<Readable> {
		await this.checkParents(key)
		await this.check(this.path(key), false)
		const handle = await open(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW)
		return handle.createReadStream()
	}

	async copy(
		source: string,
		target: string,
		expectedBytes: bigint,
		expectedChecksum: string,
	): Promise<void> {
		const input = await this.read(source)
		const checksum = await this.write(input, target, expectedBytes)
		if (checksum !== expectedChecksum) throw new Error('Stored file checksum mismatch')
		const directory = await open(dirname(this.path(target)), 'r')
		try {
			await directory.sync()
		} finally {
			await directory.close()
		}
	}

	async delete(key: string): Promise<void> {
		try {
			await this.checkParents(key)
			await this.check(this.path(key), false)
			await rm(this.path(key), { force: true })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			await this.checkParents(key)
			await this.check(this.path(key), false)
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
			throw error
		}
	}
}

export const storage = new LocalObjectStorage(env.STORAGE_ROOT)
