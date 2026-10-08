import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import { env } from '../config/env.js'

export interface ObjectStorage {
	write(input: Readable, key: string, expectedBytes: bigint): Promise<string>
	commit(stagedKey: string, key: string): Promise<void>
	read(key: string): Readable
	copy(source: string, target: string): Promise<void>
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

	async init(): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 })
		if ((await lstat(this.root)).isSymbolicLink())
			throw new Error('STORAGE_ROOT cannot be a symbolic link')
		await chmod(this.root, 0o700)
		await mkdir(join(this.root, 'staging'), { recursive: true, mode: 0o700 })
		await mkdir(join(this.root, 'objects'), { recursive: true, mode: 0o700 })
		await chmod(join(this.root, 'staging'), 0o700)
		await chmod(join(this.root, 'objects'), 0o700)
	}

	async write(input: Readable, key: string, expectedBytes: bigint): Promise<string> {
		const destination = this.path(key)
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
			await pipeline(
				input,
				verifier,
				createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
			)
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
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
		await rename(this.path(stagedKey), destination)
		const directory = await open(dirname(destination), 'r')
		try {
			await directory.sync()
		} finally {
			await directory.close()
		}
	}

	read(key: string): Readable {
		return createReadStream(this.path(key))
	}

	async copy(source: string, target: string): Promise<void> {
		const destination = this.path(target)
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
		await copyFile(this.path(source), destination)
		const file = await open(destination, 'r')
		try {
			await file.sync()
		} finally {
			await file.close()
		}
	}

	async delete(key: string): Promise<void> {
		await rm(this.path(key), { force: true })
	}

	async exists(key: string): Promise<boolean> {
		try {
			await stat(this.path(key))
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
			throw error
		}
	}
}

export const storage = new LocalObjectStorage(env.STORAGE_ROOT)
