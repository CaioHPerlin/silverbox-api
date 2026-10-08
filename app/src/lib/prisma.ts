import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { env } from '../config/env.js'

export const prisma = new PrismaClient({
	adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
})
