/**
 * Public entry of the pending-image subsystem. The implementation lives in ./images:
 * cache (identities and GC), stash (bytes), lease (pinning and restore), migration (save), references (open, paste, drop).
 */
export {
  type PendingImage,
  type PendingImageFile,
  subscribeImageSources,
  registerImageReachability,
  imageReferencesChanged,
  collectUnusedImages,
  settleImageInsertion,
  cancelImageInsertion,
  getPendingImages,
  getInFlightImages,
  clearPendingImages,
  imageIdentityReferences,
  imageTokenForUrl,
  imageUrlForToken,
  imageSourceReferences,
  imagePreviewUrl,
  unstashedImageCount,
  imageCacheUsage,
} from './images/cache';
export {
  type PendingImageLease,
  capturePendingImages,
  type StagedPendingImages,
  stagePendingImages,
  restorePendingImages,
} from './images/lease';
export {
  type ImageMigration,
  finalizeImageMigration,
  commitImageMigration,
  migratePendingImages,
} from './images/migration';
export {
  type PreparedImageReferences,
  prepareImageReferences,
  loadImageReferences,
  saveImage,
  type DroppedImageReceipt,
  importDroppedImage,
} from './images/references';
