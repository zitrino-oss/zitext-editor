use criterion::{black_box, criterion_group, criterion_main, Criterion};
use std::fs;
use std::io::Write;
use tempfile::TempDir;
use zitext_editor_lib::benchmark_support;

/// Generates a text file of approximately `size_bytes` with realistic line content.
fn create_test_file(dir: &TempDir, name: &str, size_bytes: usize) -> std::path::PathBuf {
    let path = dir.path().join(name);
    let mut f = fs::File::create(&path).unwrap();
    let line = "The quick brown fox jumps over the lazy dog. Lorem ipsum dolor sit amet.\n";
    let mut written = 0;
    while written < size_bytes {
        f.write_all(line.as_bytes()).unwrap();
        written += line.len();
    }
    path
}

/// Creates a directory tree with `file_count` files across a few subdirs.
fn create_test_tree(dir: &TempDir, file_count: usize) {
    for i in 0..file_count {
        let subdir = dir.path().join(format!("sub_{}", i % 5));
        fs::create_dir_all(&subdir).unwrap();
        let path = subdir.join(format!("file_{}.txt", i));
        fs::write(&path, format!("content of file {}\n", i)).unwrap();
    }
}

fn bench_read_small_file(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = create_test_file(&dir, "small.txt", 10 * 1024); // 10 KB
    c.bench_function("read_file_10KB", |b| {
        b.iter(|| {
            let _ = black_box(benchmark_support::read_authorized_text(&path).unwrap());
        });
    });
}

fn bench_read_medium_file(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = create_test_file(&dir, "medium.txt", 500 * 1024); // 500 KB
    c.bench_function("read_file_500KB", |b| {
        b.iter(|| {
            let _ = black_box(benchmark_support::read_authorized_text(&path).unwrap());
        });
    });
}

fn bench_read_large_file(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = create_test_file(&dir, "large.txt", 5 * 1024 * 1024); // 5 MB
    c.bench_function("read_file_5MB", |b| {
        b.iter(|| {
            let _ = black_box(benchmark_support::read_authorized_text(&path).unwrap());
        });
    });
}

fn bench_write_file(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("write_test.txt");
    let content = "x".repeat(1024 * 1024); // 1 MB
    c.bench_function("write_file_1MB", |b| {
        b.iter(|| {
            benchmark_support::write_authorized_atomic(&path, black_box(content.as_bytes()))
                .unwrap();
        });
    });
}

fn bench_search_file(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = create_test_file(&dir, "search.txt", 1024 * 1024); // 1 MB
    c.bench_function("search_file_1MB", |b| {
        b.iter(|| {
            let content = fs::read_to_string(&path).unwrap();
            let needle = "Lorem ipsum";
            let count = content.matches(black_box(needle)).count();
            black_box(count);
        });
    });
}

fn bench_read_directory(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    create_test_tree(&dir, 200);
    c.bench_function("read_directory_200_files", |b| {
        b.iter(|| {
            let mut count = 0usize;
            fn walk(path: &std::path::Path, count: &mut usize) {
                if let Ok(entries) = fs::read_dir(path) {
                    for entry in entries.flatten() {
                        *count += 1;
                        let p = entry.path();
                        if p.is_dir() {
                            walk(&p, count);
                        }
                    }
                }
            }
            walk(black_box(dir.path()), &mut count);
            black_box(count);
        });
    });
}

fn bench_validate_path(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = create_test_file(&dir, "valid.txt", 100);
    let path_str = path.to_str().unwrap().to_string();
    c.bench_function("validate_path", |b| {
        b.iter(|| {
            let p = std::path::PathBuf::from(black_box(&path_str));
            let _ = benchmark_support::authorize_for_benchmark(&p).unwrap();
        });
    });
}

criterion_group!(
    benches,
    bench_read_small_file,
    bench_read_medium_file,
    bench_read_large_file,
    bench_write_file,
    bench_search_file,
    bench_read_directory,
    bench_validate_path,
);
criterion_main!(benches);
