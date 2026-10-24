export class StorageInvalidPartsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageInvalidPartsError';
  }
}
