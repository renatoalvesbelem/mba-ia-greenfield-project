process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://minio:9000';
process.env.S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'streamtube-test';
process.env.QUEUE_PREFIX = process.env.TEST_QUEUE_PREFIX ?? 'streamtube-test';
if (process.env.TEST_DB_NAME) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_DATABASE = process.env.TEST_DB_NAME;
}
