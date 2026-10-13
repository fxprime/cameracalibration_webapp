//! Local-only web server. Vision requests are serialized through a replaceable worker.
use axum::{
    extract::{DefaultBodyLimit, State},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::Arc,
};
use tokio::sync::Mutex;
use tower_http::services::ServeDir;
struct Worker {
    child: Child,
    output: BufReader<std::process::ChildStdout>,
}
impl Worker {
    fn start() -> Self {
        let mut child = Command::new(std::env::var("CALIB_PYTHON").unwrap_or("python3".into()))
            .args(["-u", "vision/worker.py"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("Python/OpenCV worker must start");
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut worker = Self { child, output };
        worker
            .request(json!({"op":"health"}))
            .expect("OpenCV worker failed; install requirements.txt with CALIB_PYTHON");
        worker
    }
    fn request(&mut self, v: Value) -> Result<Value, String> {
        let input = self.child.stdin.as_mut().ok_or("Worker unavailable")?;
        writeln!(input, "{}", v).map_err(|e| e.to_string())?;
        input.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        self.output
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&line).map_err(|e| format!("Vision worker failed: {e}"))
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}
async fn api(State(worker): State<Arc<Mutex<Worker>>>, Json(v): Json<Value>) -> Json<Value> {
    let w = worker.clone();
    let result = tokio::task::spawn_blocking(move || w.blocking_lock().request(v)).await;
    Json(match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => json!({"error":e}),
        Err(e) => json!({"error":e.to_string()}),
    })
}
#[tokio::main]
async fn main() {
    let worker = Arc::new(Mutex::new(Worker::start()));
    let app = Router::new()
        .route("/api", post(api))
        .route(
            "/health",
            get(|| async { Json(json!({"app":"Camera Calibration Lab"})) }),
        )
        .nest_service("/examples", ServeDir::new("examples"))
        .fallback_service(ServeDir::new("web"))
        .layer(DefaultBodyLimit::max(24 * 1024 * 1024))
        .with_state(worker);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8765")
        .await
        .expect("Port 8765 unavailable");
    println!("Camera Calibration Lab: http://localhost:8765");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
