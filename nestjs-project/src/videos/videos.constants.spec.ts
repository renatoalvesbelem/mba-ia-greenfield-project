import {
  fileExtension,
  thumbnailStorageKey,
  videoStorageKey,
  videoStoragePrefix,
} from './videos.constants';

describe('videoStoragePrefix', () => {
  it('returns the videos/<id>/ prefix', () => {
    expect(videoStoragePrefix('abc-123')).toBe('videos/abc-123/');
  });
});

describe('videoStorageKey', () => {
  it('returns videos/<id>/original.<ext> when an extension is given', () => {
    expect(videoStorageKey('abc-123', 'mp4')).toBe(
      'videos/abc-123/original.mp4',
    );
  });

  it('returns videos/<id>/original without a suffix when extension is empty', () => {
    expect(videoStorageKey('abc-123', '')).toBe('videos/abc-123/original');
  });
});

describe('thumbnailStorageKey', () => {
  it('returns videos/<id>/thumbnail.jpg', () => {
    expect(thumbnailStorageKey('abc-123')).toBe('videos/abc-123/thumbnail.jpg');
  });
});

describe('fileExtension', () => {
  it('returns the lowercase extension without the dot', () => {
    expect(fileExtension('movie.MP4')).toBe('mp4');
  });

  it('returns the last extension for filenames with multiple dots', () => {
    expect(fileExtension('archive.tar.gz')).toBe('gz');
  });

  it('returns an empty string when there is no extension', () => {
    expect(fileExtension('README')).toBe('');
  });

  it('returns an empty string when the filename ends with a dot', () => {
    expect(fileExtension('weird.')).toBe('');
  });
});
