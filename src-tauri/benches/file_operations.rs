use criterion::{criterion_group, criterion_main, Criterion};
use std::fs;
use std::hint::black_box;
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
        b.iter(|| black_box(benchmark_support::read_file(&path).unwrap()));
    });
}

fn bench_read_medium_file(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = create_test_file(&dir, "medium.txt", 500 * 1024); // 500 KB
    c.bench_function("read_file_500KB", |b| {
        b.iter(|| black_box(benchmark_support::read_file(&path).unwrap()));
    });
}

fn bench_read_large_file(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = create_test_file(&dir, "large.txt", 5 * 1024 * 1024); // 5 MB
    c.bench_function("read_file_5MB", |b| {
        b.iter(|| black_box(benchmark_support::read_file(&path).unwrap()));
    });
}

/// A save of an open 1 MB file: conflict re-read and hash, then the atomic
/// replace, exactly as pressing Save runs it.
fn bench_save_file(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = create_test_file(&dir, "save_test.txt", 1024 * 1024);
    let mut file = benchmark_support::open_file(&path).unwrap();
    let edits = ["x".repeat(1024 * 1024), "y".repeat(1024 * 1024)];
    let mut turn = 0;
    c.bench_function("save_file_1MB", |b| {
        b.iter(|| {
            turn ^= 1;
            file.save(black_box(&edits[turn])).unwrap();
        });
    });
}

fn bench_search_folder(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    create_test_file(&dir, "search.txt", 1024 * 1024); // 1 MB
    create_test_tree(&dir, 200);
    benchmark_support::open_folder(dir.path());
    c.bench_function("search_in_files_1MB_plus_200_files", |b| {
        b.iter(|| black_box(benchmark_support::search_folder(dir.path(), "Lorem ipsum").unwrap()));
    });
}

fn bench_read_directory(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    create_test_tree(&dir, 200);
    for i in 0..200 {
        fs::write(dir.path().join(format!("top_{i}.txt")), b"x").unwrap();
    }
    benchmark_support::open_folder(dir.path());
    c.bench_function("read_directory_205_entries", |b| {
        b.iter(|| black_box(benchmark_support::list_folder(dir.path()).unwrap()));
    });
    c.bench_function("count_project_files_400", |b| {
        b.iter(|| black_box(benchmark_support::count_files(dir.path()).unwrap()));
    });
}

fn bench_validate_path(c: &mut Criterion) {
    let dir = TempDir::new().unwrap();
    let path = create_test_file(&dir, "valid.txt", 100);
    c.bench_function("validate_path", |b| {
        b.iter(|| black_box(benchmark_support::authorize_for_benchmark(black_box(&path)).unwrap()));
    });
}

criterion_group!(
    benches,
    bench_read_small_file,
    bench_read_medium_file,
    bench_read_large_file,
    bench_save_file,
    bench_search_folder,
    bench_read_directory,
    bench_validate_path,
);
criterion_main!(benches);
