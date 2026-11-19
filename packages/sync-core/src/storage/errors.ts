export class StorageVersionError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The local database belongs to a newer version of the app', options);
    this.name = 'StorageVersionError';
  }
}

export class LocalWriteError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Could not save to this device', options);
    this.name = 'LocalWriteError';
  }
}
