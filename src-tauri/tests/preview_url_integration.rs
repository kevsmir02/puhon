use puhon_lib::modules::pty::url_detect::UrlDetector;

#[test]
fn url_detector_basic_flow() {
    let mut d = UrlDetector::new();
    let mut urls = Vec::new();

    d.process(
        b"\x1b[2J\x1b[H\n> my-app@0.1.0 dev\n> next dev\n\n  \x1b[32m\xe2\x9c\x93 Ready in 2.3s\x1b[0m\n  Local:   \x1b[36mhttp://localhost:3000\x1b[0m\n",
        1,
        |u| urls.push(u),
    );

    assert_eq!(urls, vec!["http://localhost:3000"]);
    urls.clear();

    d.process(b"http://localhost:3000", 1, |u| urls.push(u));
    assert!(urls.is_empty());
}
