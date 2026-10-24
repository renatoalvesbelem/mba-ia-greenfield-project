import { ArgumentsHost } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter';
import {
  ChannelNotFoundException,
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
  VideoForbiddenException,
  VideoInvalidPartNumberException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUnsupportedMediaTypeException,
  VideoUploadInvalidPartsException,
} from '../exceptions/domain.exception';

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test', method: 'POST' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => ({}) as any,
      switchToWs: () => ({}) as any,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it('maps EmailAlreadyExistsException to 409 with EMAIL_ALREADY_EXISTS', () => {
    filter.catch(new EmailAlreadyExistsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'EMAIL_ALREADY_EXISTS',
      message: 'Email is already registered',
    });
  });

  it('maps InvalidCredentialsException to 401 with INVALID_CREDENTIALS', () => {
    filter.catch(new InvalidCredentialsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_CREDENTIALS',
      message: expect.any(String),
    });
  });

  it('maps EmailNotConfirmedException to 403 with EMAIL_NOT_CONFIRMED', () => {
    filter.catch(new EmailNotConfirmedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'EMAIL_NOT_CONFIRMED',
      message: expect.any(String),
    });
  });

  it('maps InvalidTokenException to 401 with INVALID_TOKEN', () => {
    filter.catch(new InvalidTokenException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_TOKEN',
      message: expect.any(String),
    });
  });

  it('maps TokenExpiredException to 401 with TOKEN_EXPIRED', () => {
    filter.catch(new TokenExpiredException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_EXPIRED',
      message: expect.any(String),
    });
  });

  it('maps TokenReuseDetectedException to 401 with TOKEN_REUSE_DETECTED', () => {
    filter.catch(new TokenReuseDetectedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_REUSE_DETECTED',
      message: expect.any(String),
    });
  });

  it('maps VideoNotFoundException to 404 with VIDEO_NOT_FOUND', () => {
    filter.catch(new VideoNotFoundException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(404);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: 'Video not found',
    });
  });

  it('maps VideoForbiddenException to 403 with VIDEO_FORBIDDEN', () => {
    filter.catch(new VideoForbiddenException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'VIDEO_FORBIDDEN',
      message: 'You do not own this video',
    });
  });

  it('maps VideoInvalidStateException to 409 with VIDEO_INVALID_STATE citing current and allowed statuses', () => {
    filter.catch(new VideoInvalidStateException('ready', ['draft']), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'VIDEO_INVALID_STATE',
      message: expect.stringContaining('ready'),
    });
    expect(mockJson.mock.calls[0][0].message).toContain('draft');
  });

  it('maps VideoTooLargeException to 413 with VIDEO_TOO_LARGE', () => {
    filter.catch(new VideoTooLargeException(10_737_418_240), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(413);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 413,
      error: 'VIDEO_TOO_LARGE',
      message: expect.any(String),
    });
  });

  it('maps VideoUnsupportedMediaTypeException to 415 with VIDEO_UNSUPPORTED_MEDIA_TYPE', () => {
    filter.catch(
      new VideoUnsupportedMediaTypeException(['video/mp4']),
      mockHost,
    );

    expect(mockStatus).toHaveBeenCalledWith(415);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 415,
      error: 'VIDEO_UNSUPPORTED_MEDIA_TYPE',
      message: expect.any(String),
    });
  });

  it('maps VideoInvalidPartNumberException to 400 with VIDEO_INVALID_PART_NUMBER', () => {
    filter.catch(new VideoInvalidPartNumberException(5), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VIDEO_INVALID_PART_NUMBER',
      message: expect.any(String),
    });
  });

  it('maps VideoUploadInvalidPartsException to 400 with VIDEO_UPLOAD_INVALID_PARTS', () => {
    filter.catch(new VideoUploadInvalidPartsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VIDEO_UPLOAD_INVALID_PARTS',
      message: expect.any(String),
    });
  });

  it('maps ChannelNotFoundException to 404 with CHANNEL_NOT_FOUND', () => {
    filter.catch(new ChannelNotFoundException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(404);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 404,
      error: 'CHANNEL_NOT_FOUND',
      message: 'Channel not found',
    });
  });
});
