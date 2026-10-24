export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoForbiddenException extends DomainException {
  constructor() {
    super('VIDEO_FORBIDDEN', 403, 'You do not own this video');
  }
}

export class VideoInvalidStateException extends DomainException {
  constructor(current: string, allowed: readonly string[]) {
    super(
      'VIDEO_INVALID_STATE',
      409,
      `Video status is "${current}", but this operation requires one of: ${allowed.join(', ')}`,
    );
  }
}

export class VideoTooLargeException extends DomainException {
  constructor(maxBytes: number) {
    super(
      'VIDEO_TOO_LARGE',
      413,
      `Video size exceeds the maximum allowed size of ${maxBytes} bytes`,
    );
  }
}

export class VideoUnsupportedMediaTypeException extends DomainException {
  constructor(allowed: readonly string[]) {
    super(
      'VIDEO_UNSUPPORTED_MEDIA_TYPE',
      415,
      `Content type is not supported. Allowed types: ${allowed.join(', ')}`,
    );
  }
}

export class VideoInvalidPartNumberException extends DomainException {
  constructor(partCount: number) {
    super(
      'VIDEO_INVALID_PART_NUMBER',
      400,
      `Part number must be between 1 and ${partCount}`,
    );
  }
}

export class VideoUploadInvalidPartsException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_INVALID_PARTS',
      400,
      'The provided upload parts were rejected by storage',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found');
  }
}
