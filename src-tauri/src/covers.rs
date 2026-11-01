//! Local cover responses and on-demand, persistent statistics thumbnails.
use std::borrow::Cow;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use image::imageops::FilterType;
use parking_lot::Mutex;
use percent_encoding::percent_decode_str;
use sha2::{Digest, Sha256};
use tauri::http::{Request, Response};
use tokio::sync::Semaphore;

type CoverResponse = Response<Cow<'static, [u8]>>;
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const REVALIDATE: &str = "public, no-cache";
const CACHE_BYTES: u64 = 64 * 1024 * 1024;
const CACHE_ENTRIES: usize = 2000;
// Bump this namespace when changing the resize/encoding recipe.
const THUMBNAIL_REVISION: &str = "stats-v1";

/// Metadata-only identity: normal writes change mtime (nanoseconds) or size. An
/// external editor deliberately preserving both is outside this invalidation
/// contract; hashing every full-resolution cover during get_stats is avoided.
pub(crate) fn file_version(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let stamp = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(format!("{:x}-{:x}", stamp.as_nanos(), metadata.len()))
}

fn cover_file_name(requested: &str) -> Option<&str> {
    Path::new(requested)
        .file_name()?
        .to_str()
        .filter(|name| !name.is_empty())
}

/// Resolve the same basename as the covers protocol, so a portable install's
/// old absolute database paths still identify files in its current data folder.
pub(crate) fn selected_file_version(covers_dir: &Path, requested: &str) -> String {
    cover_file_name(requested)
        .and_then(|name| file_version(&covers_dir.join(name)))
        .unwrap_or_default()
}

#[derive(Debug, PartialEq)]
struct CoverQuery {
    height: Option<u32>,
    version: Option<String>,
}

impl CoverQuery {
    fn parse(query: Option<&str>) -> Result<Self, ()> {
        let mut thumb = None;
        let mut height = None;
        let mut version = None;
        for part in query
            .unwrap_or_default()
            .split('&')
            .filter(|p| !p.is_empty())
        {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            let key = percent_decode_str(key).decode_utf8().map_err(|_| ())?;
            let value = percent_decode_str(value).decode_utf8().map_err(|_| ())?;
            match key.as_ref() {
                "thumb" if thumb.is_none() => thumb = Some(value.into_owned()),
                "h" if height.is_none() => height = Some(value.into_owned()),
                "v" if version.is_none() => version = Some(value.into_owned()),
                "thumb" | "h" | "v" => return Err(()),
                _ => {}
            }
        }
        let height = match thumb.as_deref() {
            None => None,
            Some("stats") => match height.as_deref() {
                Some("72") => Some(72),
                Some("144") => Some(144),
                Some("216") => Some(216),
                _ => return Err(()),
            },
            _ => return Err(()),
        };
        Ok(Self {
            height,
            version: version.filter(|value| !value.is_empty()),
        })
    }
}

pub(crate) struct CoverService {
    covers_dir: PathBuf,
    cache_dir: PathBuf,
    workers: Arc<Semaphore>,
    // Fixed stripes keep lock bookkeeping bounded. All variants of a source
    // share a lock, so a simultaneous request cannot resize that source twice.
    source_locks: [Mutex<()>; 64],
    cache_write: Mutex<()>,
    #[cfg(test)]
    generations: std::sync::atomic::AtomicUsize,
}

impl CoverService {
    pub(crate) fn new(covers_dir: PathBuf) -> Self {
        let cache_dir = covers_dir.join(".stats-thumbnails-v1");
        Self {
            covers_dir,
            cache_dir,
            workers: Arc::new(Semaphore::new(2)),
            source_locks: std::array::from_fn(|_| Mutex::new(())),
            cache_write: Mutex::new(()),
            #[cfg(test)]
            generations: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// The URI callback only schedules work. Metadata, disk IO and image decode
    /// run on blocking workers, with at most two requests executing at once.
    pub(crate) fn dispatch(
        self: &Arc<Self>,
        request: Request<Vec<u8>>,
        responder: tauri::UriSchemeResponder,
    ) {
        let service = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let permit = Arc::clone(&service.workers).acquire_owned().await;
            let response = match permit {
                Ok(permit) => tauri::async_runtime::spawn_blocking(move || {
                    let _permit = permit;
                    service.serve(&request)
                })
                .await
                .unwrap_or_else(|_| error_response(500, "cover worker failed")),
                Err(_) => error_response(503, "cover workers unavailable"),
            };
            responder.respond(response);
        });
    }

    fn serve(&self, request: &Request<Vec<u8>>) -> CoverResponse {
        let query = match CoverQuery::parse(request.uri().query()) {
            Ok(query) => query,
            Err(_) => return error_response(400, "invalid thumbnail specification"),
        };
        let encoded = request.uri().path().trim_start_matches('/');
        let decoded = percent_decode_str(encoded).decode_utf8_lossy();
        // Retain the original covers contract: encoded absolute paths resolve
        // to a filename inside covers; clients never select a cache path.
        let file_name = match cover_file_name(decoded.as_ref()) {
            Some(name) => name,
            _ => return error_response(404, "not found"),
        };
        let path = self.covers_dir.join(file_name);
        let source_hash = Sha256::digest(file_name.as_bytes());
        let _source_lock = query
            .height
            .map(|_| self.source_locks[source_hash[0] as usize % 64].lock());
        let version = match file_version(&path) {
            Some(version) => version,
            None => return error_response(404, "not found"),
        };
        let variant = query
            .height
            .map(|height| format!("{THUMBNAIL_REVISION}-h{height}"))
            .unwrap_or_else(|| "original".into());
        let etag = format!("\"{variant}-{version}\"");
        // Ordinary callers already use app timestamps as v. Stats uses the
        // metadata identity: stale v never receives an immutable new response.
        let versioned = match query.height {
            Some(_) => query.version.as_deref() == Some(version.as_str()),
            None => query.version.is_some(),
        };
        let cache_control = if versioned { IMMUTABLE } else { REVALIDATE };
        if etag_matches(request, &etag) {
            return response(304, &etag, cache_control, None, Vec::new());
        }
        let bytes = match query.height {
            Some(height) => {
                let source_id = format!("{source_hash:x}");
                match self.thumbnail(&path, &source_id, &version, height) {
                    Ok(bytes) => bytes,
                    Err(ThumbnailError::Changed) => {
                        return error_response(409, "cover changed during thumbnail generation")
                    }
                    Err(ThumbnailError::Decode) => {
                        return error_response(422, "unsupported cover image")
                    }
                    Err(ThumbnailError::Io) => return error_response(404, "not found"),
                }
            }
            None => match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => return error_response(404, "not found"),
            },
        };
        response(200, &etag, cache_control, Some(image_mime(&bytes)), bytes)
    }

    fn thumbnail(
        &self,
        source: &Path,
        source_id: &str,
        version: &str,
        height: u32,
    ) -> Result<Vec<u8>, ThumbnailError> {
        let prefix = format!("{source_id}-{version}-");
        let target = self.cache_dir.join(format!("{prefix}h{height}.thumb"));
        if let Ok(bytes) = fs::read(&target) {
            return Ok(bytes);
        }
        #[cfg(test)]
        self.generations
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut reader = image::ImageReader::open(source)
            .map_err(|_| ThumbnailError::Io)?
            .with_guessed_format()
            .map_err(|_| ThumbnailError::Decode)?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16_384);
        limits.max_image_height = Some(16_384);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let original = reader.decode().map_err(|_| ThumbnailError::Decode)?;
        // resize() preserves aspect ratio; min(source dimension) prevents
        // upscaling. Very wide panoramas are bounded by 4 * selected height.
        let resized = original.resize(
            (height * 4).min(original.width()),
            height.min(original.height()),
            FilterType::Triangle,
        );
        let mut bytes = Vec::new();
        if resized.color().has_alpha() {
            resized
                .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
                .map_err(|_| ThumbnailError::Decode)?;
        } else {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85)
                .encode_image(&resized.to_rgb8())
                .map_err(|_| ThumbnailError::Decode)?;
        }
        // An overwrite during decode must not publish bytes under the old key.
        if file_version(source).as_deref() != Some(version) {
            return Err(ThumbnailError::Changed);
        }
        // Disk caching is best effort (e.g. read-only data directory). Serving
        // the generated thumbnail still succeeds if persistence fails.
        let _cache_write = self.cache_write.lock();
        if fs::create_dir_all(&self.cache_dir).is_ok() {
            let staging = target.with_extension("tmp");
            if fs::write(&staging, &bytes).is_ok() {
                if fs::rename(&staging, &target).is_ok() {
                    self.prune_cache(source_id, &prefix, CACHE_BYTES, CACHE_ENTRIES);
                } else {
                    let _ = fs::remove_file(staging);
                }
            } else {
                let _ = fs::remove_file(staging);
            }
        }
        Ok(bytes)
    }

    /// Delete old versions of this source and evict oldest generated files to
    /// enforce both disk budgets. Only our dedicated directory is enumerated.
    fn prune_cache(
        &self,
        source_id: &str,
        current_prefix: &str,
        max_bytes: u64,
        max_entries: usize,
    ) {
        let Ok(entries) = fs::read_dir(&self.cache_dir) else {
            return;
        };
        let source_prefix = format!("{source_id}-");
        let mut retained = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            // A process interrupted between write and rename can leave staging
            // files; no other writer runs while cache_write is held.
            if path.extension().and_then(|ext| ext.to_str()) == Some("tmp") {
                let _ = fs::remove_file(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("thumb") {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&source_prefix)
                && !name.starts_with(current_prefix)
                && fs::remove_file(&path).is_ok()
            {
                continue;
            }
            retained.push((
                metadata.modified().unwrap_or(UNIX_EPOCH),
                path,
                metadata.len(),
            ));
        }
        retained.sort_by_key(|(modified, _, _)| *modified);
        let mut bytes: u64 = retained.iter().map(|(_, _, size)| *size).sum();
        let mut count = retained.len();
        for (_, path, size) in retained {
            if bytes <= max_bytes && count <= max_entries {
                break;
            }
            if fs::remove_file(path).is_ok() {
                bytes = bytes.saturating_sub(size);
                count -= 1;
            }
        }
    }
}

enum ThumbnailError {
    Io,
    Decode,
    Changed,
}

fn etag_matches(request: &Request<Vec<u8>>, etag: &str) -> bool {
    request
        .headers()
        .get("if-none-match")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim();
                candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == etag
            })
        })
        .unwrap_or(false)
}

fn image_mime(bytes: &[u8]) -> &'static str {
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::WebP) => "image/webp",
        Ok(image::ImageFormat::Gif) => "image/gif",
        Ok(image::ImageFormat::Bmp) => "image/bmp",
        _ => "image/jpeg",
    }
}

fn response(
    status: u16,
    etag: &str,
    cache_control: &str,
    mime: Option<&str>,
    bytes: Vec<u8>,
) -> CoverResponse {
    let mut builder = Response::builder()
        .status(status)
        .header("Cache-Control", cache_control)
        .header("ETag", etag)
        .header("Access-Control-Allow-Origin", "*");
    if let Some(mime) = mime {
        builder = builder.header("Content-Type", mime);
    }
    builder.body(Cow::Owned(bytes)).unwrap()
}

fn error_response(status: u16, message: &'static str) -> CoverResponse {
    Response::builder()
        .status(status)
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Cow::Borrowed(message.as_bytes()))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    struct Fixture {
        root: PathBuf,
        service: CoverService,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("zex-stats-covers-{}", uuid::Uuid::new_v4()));
            let covers = root.join("covers");
            fs::create_dir_all(&covers).unwrap();
            Self {
                root,
                service: CoverService::new(covers),
            }
        }
        fn save(&self, name: &str, width: u32, height: u32, color: u8) -> PathBuf {
            let path = self.service.covers_dir.join(name);
            image::RgbImage::from_pixel(width, height, image::Rgb([color, 50, 100]))
                .save(&path)
                .unwrap();
            path
        }
        fn get(&self, query: &str) -> CoverResponse {
            self.service.serve(
                &Request::builder()
                    .uri(format!("http://covers.localhost/{query}"))
                    .body(Vec::new())
                    .unwrap(),
            )
        }
        fn files(&self) -> Vec<PathBuf> {
            fs::read_dir(&self.service.cache_dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn stats_cover_version_resolves_relocated_absolute_paths_like_protocol() {
        let fixture = Fixture::new();
        let current = fixture.save("cover.png", 10, 10, 20);
        let old = fixture
            .root
            .join("old-install")
            .join("covers")
            .join("cover.png");
        assert!(!old.exists());
        let version = selected_file_version(&fixture.service.covers_dir, &old.to_string_lossy());
        assert_eq!(Some(version.as_str()), file_version(&current).as_deref());
        let encoded = urlencoding::encode(&old.to_string_lossy()).into_owned();
        let response = fixture.get(&format!("{encoded}?thumb=stats&h=72&v={version}"));
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], IMMUTABLE);
        assert_eq!(
            selected_file_version(&fixture.service.covers_dir, "missing.png"),
            ""
        );
    }

    #[test]
    fn stats_cover_version_is_stable_and_tracks_submillisecond_same_size_writes() {
        let fixture = Fixture::new();
        let path = fixture.save("cover.png", 10, 10, 20);
        let timestamp = UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(timestamp))
            .unwrap();
        let old = file_version(&path).unwrap();
        assert_eq!(file_version(&path).as_deref(), Some(old.as_str()));
        file.set_times(
            fs::FileTimes::new().set_modified(timestamp + std::time::Duration::from_nanos(100_000)),
        )
        .unwrap();
        assert_ne!(file_version(&path).unwrap(), old);
    }

    #[test]
    fn stats_thumbnails_preserve_aspect_ratio_and_never_upscale() {
        let fixture = Fixture::new();
        for (name, width, height, selected, expected) in [
            ("wide.png", 1920, 620, 72, (223, 72)),
            ("retina.png", 1920, 620, 144, (446, 144)),
            ("triple.png", 1920, 620, 216, (669, 216)),
            ("panorama.png", 2000, 200, 72, (288, 29)),
            ("square.png", 256, 256, 72, (72, 72)),
            ("small.png", 32, 16, 216, (32, 16)),
        ] {
            let path = fixture.save(name, width, height, 40);
            let before = fs::read(&path).unwrap();
            let response = fixture.get(&format!("{name}?thumb=stats&h={selected}"));
            assert_eq!(response.status(), 200, "{name}");
            assert_eq!(
                image::load_from_memory(response.body())
                    .unwrap()
                    .dimensions(),
                expected,
                "{name}"
            );
            assert_eq!(fs::read(path).unwrap(), before, "original is unchanged");
        }
    }

    #[test]
    fn stats_thumbnail_cache_reuses_bytes_and_file_without_rebuilding() {
        let fixture = Fixture::new();
        fixture.save("cover.png", 800, 300, 20);
        let first = fixture.get("cover.png?thumb=stats&h=72");
        let files = fixture.files();
        assert_eq!(files.len(), 1);
        // Use an old timestamp to detect a rewrite without depending on sleeps
        // or filesystem timestamp resolution.
        let timestamp = UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        fs::File::options()
            .write(true)
            .open(&files[0])
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(timestamp))
            .unwrap();
        let second = fixture.get("cover.png?thumb=stats&h=72");
        assert_eq!(first.body(), second.body());
        assert_eq!(
            fs::metadata(&files[0]).unwrap().modified().unwrap(),
            timestamp
        );
        assert_eq!(
            fixture
                .service
                .generations
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }

    #[test]
    fn stats_thumbnail_overwrite_changes_version_bytes_and_removes_old_variants() {
        let fixture = Fixture::new();
        let path = fixture.save("cover.png", 800, 300, 20);
        let old_version = file_version(&path).unwrap();
        let old = fixture.get(&format!("cover.png?thumb=stats&h=72&v={old_version}"));
        let old_file = fixture.files().pop().unwrap();
        fixture.save("cover.png", 801, 300, 220);
        let new_version = file_version(&path).unwrap();
        assert_ne!(old_version, new_version);
        let new = fixture.get(&format!("cover.png?thumb=stats&h=72&v={new_version}"));
        assert_ne!(old.body(), new.body());
        assert_ne!(old.headers()["etag"], new.headers()["etag"]);
        assert_eq!(new.headers()["cache-control"], IMMUTABLE);
        assert!(!old_file.exists());
        let stale = fixture.get(&format!("cover.png?thumb=stats&h=72&v={old_version}"));
        assert_eq!(stale.body(), new.body());
        assert_eq!(stale.headers()["cache-control"], REVALIDATE);
    }

    #[test]
    fn stats_thumbnail_etag_is_variant_specific_and_304_does_not_generate() {
        let fixture = Fixture::new();
        let path = fixture.save("cover.png", 800, 300, 20);
        let version = file_version(&path).unwrap();
        let url = format!("cover.png?thumb=stats&h=72&v={version}");
        let first = fixture.get(&url);
        let large = fixture.get("cover.png?thumb=stats&h=144");
        let original = fixture.get("cover.png");
        assert_ne!(first.headers()["etag"], large.headers()["etag"]);
        assert_ne!(first.headers()["etag"], original.headers()["etag"]);
        for file in fixture.files() {
            fs::remove_file(file).unwrap();
        }
        let request = Request::builder()
            .uri(format!("http://covers.localhost/{url}"))
            .header(
                "If-None-Match",
                format!("\"other\", W/{}", first.headers()["etag"].to_str().unwrap()),
            )
            .body(Vec::new())
            .unwrap();
        let cached = fixture.service.serve(&request);
        assert_eq!(cached.status(), 304);
        assert!(cached.body().is_empty());
        assert_eq!(cached.headers()["cache-control"], IMMUTABLE);
        assert_eq!(cached.headers()["access-control-allow-origin"], "*");
        assert!(fixture.files().is_empty());
        assert_eq!(original.body().as_ref(), fs::read(path).unwrap());
        assert_eq!(original.headers()["cache-control"], REVALIDATE);
        assert_eq!(
            fixture.get("cover.png?v=legacy-timestamp").headers()["cache-control"],
            IMMUTABLE
        );
    }

    #[test]
    fn stats_thumbnail_errors_have_cors_and_invalid_sizes_do_not_create_files() {
        let fixture = Fixture::new();
        fixture.save("cover.png", 100, 100, 20);
        for query in [
            "thumb=stats",
            "thumb=stats&h=0",
            "thumb=stats&h=73",
            "thumb=stats&h=999999999",
            "thumb=other&h=72",
            "thumb=stats&h=72&h=144",
        ] {
            let response = fixture.get(&format!("cover.png?{query}"));
            assert_eq!(response.status(), 400, "{query}");
            assert_eq!(response.headers()["access-control-allow-origin"], "*");
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
        assert!(fixture.files().is_empty());
        let missing = fixture.get("missing.png?thumb=stats&h=72");
        assert_eq!(missing.status(), 404);
        assert_eq!(missing.headers()["access-control-allow-origin"], "*");
        fs::write(fixture.service.covers_dir.join("bad.png"), b"not an image").unwrap();
        assert_eq!(fixture.get("bad.png?thumb=stats&h=72").status(), 422);
        assert!(file_version(&fixture.root).is_none());
    }

    #[test]
    fn stats_thumbnail_parallel_requests_share_one_cached_file() {
        let fixture = Fixture::new();
        fixture.save("cover.png", 800, 300, 20);
        std::thread::scope(|scope| {
            let requests: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| fixture.get("cover.png?thumb=stats&h=72")))
                .collect();
            let bodies: Vec<_> = requests
                .into_iter()
                .map(|worker| worker.join().unwrap().into_body())
                .collect();
            assert!(bodies.windows(2).all(|pair| pair[0] == pair[1]));
        });
        assert_eq!(fixture.files().len(), 1);
        assert_eq!(
            fixture
                .service
                .generations
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }

    #[test]
    fn stats_thumbnail_disk_cache_enforces_byte_and_entry_budgets() {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.service.cache_dir).unwrap();
        for index in 0..4 {
            fs::write(
                fixture
                    .service
                    .cache_dir
                    .join(format!("test-{index}.thumb")),
                [0; 50],
            )
            .unwrap();
        }
        fixture
            .service
            .prune_cache("unrelated", "unrelated-current-", 120, 1);
        assert_eq!(fixture.files().len(), 1);
        let bytes: u64 = fixture
            .files()
            .iter()
            .map(|path| fs::metadata(path).unwrap().len())
            .sum();
        assert!(bytes <= 120);
    }
}
