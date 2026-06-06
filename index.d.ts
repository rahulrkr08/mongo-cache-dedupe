import type { Collection, Db } from 'mongodb'

export interface MongoStorageInvalidationOptions {
  referencesTTL?: number
}

export interface MongoStorageOptions {
  /** MongoDB collection instance. Required if `db` is not provided. */
  collection?: Collection
  /** MongoDB database instance. Required if `collection` is not provided. */
  db?: Db
  /** Collection name when `db` is provided. Defaults to `'cache'`. */
  collectionName?: string
  /** Invalidation configuration. */
  invalidation?: MongoStorageInvalidationOptions | boolean
}

export declare class MongoStorage {
  constructor(options: MongoStorageOptions)

  get(key: string): Promise<any>
  set(key: string, value: any, ttl: number, references?: string | string[]): Promise<void>
  remove(key: string): Promise<void>
  invalidate(references: string | string[]): Promise<void>
  clear(): Promise<void>
  refresh(key: string, ttl: number): Promise<void>
  getTTL(key: string): Promise<number>
  exists(key: string): Promise<boolean>
}
