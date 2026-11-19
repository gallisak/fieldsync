export class StorageVersionError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The local database belongs to a newer version of the app', options);
    this.name = 'StorageVersionError';
  }
}
