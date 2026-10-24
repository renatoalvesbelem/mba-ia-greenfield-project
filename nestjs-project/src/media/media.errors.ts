export class MediaProcessingError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'MediaProcessingError';
  }
}
