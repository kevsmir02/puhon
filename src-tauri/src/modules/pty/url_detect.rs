use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[allow(dead_code)]
#[derive(Clone, serde::Serialize)]
pub struct PreviewUrlEvent {
    pub pty_id: u32,
    pub url: String,
}

#[allow(dead_code)]
pub struct UrlDetector {
    matcher: RegexMatcher,
    last_url: HashMap<u32, (String, Instant)>,
    clean: Vec<u8>,
}

#[allow(dead_code)]
impl UrlDetector {
    pub fn new() -> Self {
        Self {
            matcher: RegexMatcher::new(
                r"https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d{1,5})?(/\S*)?"
            ).expect("url_detect regex compile"),
            last_url: HashMap::new(),
            clean: Vec::with_capacity(8192),
        }
    }

    pub fn process<F: FnMut(String)>(&mut self, input: &[u8], pty_id: u32, mut emit: F) {
        self.clean.clear();
        strip_ansi_escapes(input, &mut self.clean);

        let entry = self.last_url.entry(pty_id).or_insert_with(|| {
            (String::new(), Instant::now() - Duration::from_secs(1))
        });
        let (ref mut last, ref mut last_emit) = *entry;
        let clean = &self.clean;

        let _ = self.matcher.find_iter(clean, |m| -> bool {
            let url = std::str::from_utf8(&clean[m.start()..m.end()])
                .unwrap_or("");
            if url.is_empty() || url == *last {
                return true;
            }
            let now = Instant::now();
            if now.duration_since(*last_emit) < Duration::from_millis(500) {
                return true;
            }
            *last = url.to_string();
            *last_emit = now;
            emit(url.to_string());
            true
        });
    }

    pub fn clear(&mut self, pty_id: u32) {
        self.last_url.remove(&pty_id);
    }
}

fn strip_ansi_escapes(input: &[u8], out: &mut Vec<u8>) {
    let mut i = 0;
    let len = input.len();
    while i < len {
        if input[i] == 0x1b && i + 1 < len && input[i + 1] == b'[' {
            i += 2;
            while i < len && !(0x40..=0x7e).contains(&input[i]) {
                i += 1;
            }
            if i < len {
                i += 1;
            }
        } else if input[i] == 0x1b && i + 1 < len && input[i + 1] == b']' {
            i += 2;
            while i < len {
                if input[i] == 0x1b && i + 1 < len && input[i + 1] == b'\\' {
                    i += 2;
                    break;
                }
                if input[i] == 0x07 {
                    i += 1;
                    break;
                }
                i += 1;
            }
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(input: &[u8]) -> Vec<String> {
        let mut d = UrlDetector::new();
        let mut out = Vec::new();
        d.process(input, 1, |url| out.push(url));
        out
    }

    #[test]
    fn basic_localhost() {
        let urls = detect(b"Starting dev server on http://localhost:3000");
        assert_eq!(urls, vec!["http://localhost:3000"]);
    }

    #[test]
    fn https_localhost() {
        let urls = detect(b"Ready: https://localhost:8443/api");
        assert_eq!(urls, vec!["https://localhost:8443/api"]);
    }

    #[test]
    fn ipv4_loopback() {
        let urls = detect(b"http://127.0.0.1:5173/");
        assert_eq!(urls, vec!["http://127.0.0.1:5173/"]);
    }

    #[test]
    fn ipv6_loopback() {
        let urls = detect(b"http://[::1]:3000");
        assert_eq!(urls, vec!["http://[::1]:3000"]);
    }

    #[test]
    fn no_port() {
        let urls = detect(b"http://localhost/hello");
        assert_eq!(urls, vec!["http://localhost/hello"]);
    }

    #[test]
    fn zero_ip() {
        let urls = detect(b"http://0.0.0.0:8080");
        assert_eq!(urls, vec!["http://0.0.0.0:8080"]);
    }

    #[test]
    fn non_localhost_ignored() {
        let urls = detect(b"http://example.com:3000 https://myapp.vercel.app");
        assert!(urls.is_empty());
    }

    #[test]
    fn ansi_interleaved_url() {
        let input = b"Local: \x1b[1mhttp://localhost:3000\x1b[0m";
        let urls = detect(input);
        assert_eq!(urls, vec!["http://localhost:3000"]);
    }

    #[test]
    fn dedup_same_url() {
        let mut d = UrlDetector::new();
        let mut out = Vec::new();
        let input = b"http://localhost:3000";
        d.process(input, 1, |u| out.push(u));
        assert_eq!(out.len(), 1);
        let mut out2 = Vec::new();
        d.process(input, 1, |u| out2.push(u));
        assert!(out2.is_empty(), "duplicate should be suppressed");
    }

    #[test]
    fn different_url_emits() {
        let mut d = UrlDetector::new();
        let mut out = Vec::new();
        d.process(b"http://localhost:3000", 1, |u| out.push(u));
        assert_eq!(out.len(), 1);
        let mut out2 = Vec::new();
        d.process(b"http://localhost:5173", 2, |u| out2.push(u));
        assert_eq!(out2, vec!["http://localhost:5173"]);
    }

    #[test]
    fn url_with_path_and_query() {
        let urls = detect(b"http://localhost:3000/api/users?id=1");
        assert_eq!(urls, vec!["http://localhost:3000/api/users?id=1"]);
    }

    #[test]
    fn clear_forgets_state() {
        let mut d = UrlDetector::new();
        let mut out = Vec::new();
        d.process(b"http://localhost:3000", 1, |u| out.push(u));
        assert_eq!(out.len(), 1);
        d.clear(1);
        let mut out2 = Vec::new();
        d.process(b"http://localhost:3000", 1, |u| out2.push(u));
        assert_eq!(out2, vec!["http://localhost:3000"]);
    }
}
