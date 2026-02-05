// AI-powered file classification using OpenAI GPT

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ClassifierError {
    #[error("OPENAI_API_KEY not set in environment")]
    MissingApiKey,

    #[error("Failed to create HTTP client: {0}")]
    HttpClient(#[from] reqwest::Error),

    #[error("OpenAI API error (status {0})")]
    ApiStatus(reqwest::StatusCode),

    #[error("OpenAI returned no choices")]
    NoChoices,

    #[error("Failed to parse GPT JSON response: {source}. Content: {content}")]
    ParseJson {
        source: serde_json::Error,
        content: String,
    },

    #[error("Failed to read file: {0}")]
    FileRead(#[source] std::io::Error),

    #[error("Image file too large ({actual_mb:.1} MB). Maximum is {max_mb} MB.")]
    ImageTooLarge { actual_mb: f64, max_mb: u64 },

    #[error("Failed to extract PDF text: {0}")]
    PdfExtract(String),

    #[error("Failed to load image for OCR: {0}")]
    OcrLoad(String),

    #[error("OCR extraction failed: {0}")]
    OcrExtract(String),
}

// Convert ClassifierError to String for Tauri command compatibility
impl From<ClassifierError> for String {
    fn from(err: ClassifierError) -> String {
        err.to_string()
    }
}

const API_TIMEOUT_SECS: u64 = 30;
const MAX_IMAGE_SIZE_BYTES: u64 = 20 * 1024 * 1024; // 20 MB
const MIN_API_INTERVAL_MS: u64 = 500; // Minimum 500ms between API calls

/// Simple rate limiter to prevent rapid-fire API calls
static LAST_API_CALL: Mutex<Option<Instant>> = Mutex::new(None);

fn rate_limit() {
    let mut last = LAST_API_CALL.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(prev) = *last {
        let elapsed = prev.elapsed();
        let min_interval = Duration::from_millis(MIN_API_INTERVAL_MS);
        if elapsed < min_interval {
            std::thread::sleep(min_interval - elapsed);
        }
    }
    *last = Some(Instant::now());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Classification {
    pub is_relevant: bool,
    pub suggested_folder: String,
    pub confidence: f32,
    pub reasoning: String,
}

// --- Request types for text-only (GPT-3.5) ---

#[derive(Serialize)]
struct TextRequest {
    model: String,
    messages: Vec<TextMessage>,
    temperature: f32,
}

#[derive(Serialize)]
struct TextMessage {
    role: String,
    content: String,
}

// --- Request types for vision (GPT-4o) ---

#[derive(Serialize)]
struct VisionRequest {
    model: String,
    messages: Vec<VisionMessage>,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Serialize)]
struct VisionMessage {
    role: String,
    content: Vec<VisionContent>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum VisionContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlData },
}

#[derive(Serialize)]
struct ImageUrlData {
    url: String,
    detail: String,
}

// --- Shared response types ---

#[derive(Deserialize)]
struct OpenAIResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Deserialize)]
struct ResponseMessage {
    content: String,
}

#[derive(Deserialize)]
struct GptResponse {
    is_relevant: Option<bool>,
    folder: String,
    confidence: f32,
    reasoning: String,
}

enum PromptMode {
    FilenameOnly,
    Vision,
    TextContent(String), // extracted text snippet
}

/// Build the classification prompt
fn build_prompt(
    filename: &str,
    available_folders: &[String],
    correction_history: &[String],
    mode: PromptMode,
) -> String {
    let corrections_section = if correction_history.is_empty() {
        String::new()
    } else {
        let examples = correction_history.join("\n");
        format!(
            r#"

Learn from these past corrections by the user:
{}

Use these examples to improve your accuracy. If a similar filename appears, apply what you learned."#,
            examples
        )
    };

    let (content_instruction, content_section) = match &mode {
        PromptMode::Vision => (
            "Look at the image content to understand what this file is about. Use the visual content (text, formulas, diagrams, code, lecture slides, handwritten notes) to determine the subject matter, NOT just the filename. IMPORTANT: Screenshots of lecture notes, textbook pages, slides, formulas, code, academic websites, or any educational content ARE relevant coursework material — treat them the same as a PDF or document about that subject.".to_string(),
            String::new(),
        ),
        PromptMode::TextContent(text) => (
            "IMPORTANT: Classify this file based PRIMARILY on the extracted text content below, NOT the filename. The filename may be generic (like 'PS2.pdf' or 'notes.pdf') but the actual content reveals the subject. Look for subject-specific keywords, course names, topics, formulas, or terminology in the extracted text to determine the correct folder.".to_string(),
            format!("\n\nExtracted text content (PRIORITIZE THIS for classification):\n{}", text),
        ),
        PromptMode::FilenameOnly => (
            "Given a filename, first decide if it is educational/coursework material, then suggest the best folder.".to_string(),
            String::new(),
        ),
    };

    format!(
        r#"You are a file organization assistant for a student. {content_instruction}

Filename: {filename}{content_section}

Available course folders:
{folders}

Respond with ONLY a JSON object in this format:
{{
  "is_relevant": true,
  "folder": "suggested folder path",
  "confidence": 0.95,
  "reasoning": "brief explanation"
}}

Rules:
- is_relevant: true if the file is educational material (lecture slides, notes, assignments, textbooks, academic papers, course-related documents, ChatGPT conversations about coursework, screenshots of lecture content, screenshots of formulas/equations, screenshots of code/tutorials, screenshots of academic websites or textbook pages). Set false for memes, entertainment, games, personal photos, installers, music, videos unrelated to courses, social media content, screenshots of non-academic things like social media or shopping, etc.
- If is_relevant is false, set folder to "" and confidence to 0
- If is_relevant is true and the file clearly belongs to one of the available folders, use the exact folder path from the list
- If is_relevant is true but the file does NOT fit any of the available folders, set folder to "__UNSORTED__" — do NOT force-fit it into an unrelated folder
- confidence should be 0-1 (1 = very confident)
- Consider file extension, name patterns, and common use cases
- Be concise in reasoning{corrections}"#,
        content_instruction = content_instruction,
        filename = filename,
        content_section = content_section,
        folders = available_folders.join("\n"),
        corrections = corrections_section
    )
}

/// Parse the GPT response JSON into a Classification
fn parse_response(content: &str) -> Result<Classification, ClassifierError> {
    let json_str = if content.contains("```json") {
        content
            .split("```json")
            .nth(1)
            .and_then(|s| s.split("```").next())
            .unwrap_or(content)
            .trim()
    } else if content.contains("```") {
        content
            .split("```")
            .nth(1)
            .unwrap_or(content)
            .trim()
    } else {
        content.trim()
    };

    let gpt_response: GptResponse = serde_json::from_str(json_str)
        .map_err(|e| ClassifierError::ParseJson {
            source: e,
            content: json_str.to_string(),
        })?;

    // Clamp confidence to [0.0, 1.0] range
    let confidence = gpt_response.confidence.clamp(0.0, 1.0);

    Ok(Classification {
        is_relevant: gpt_response.is_relevant.unwrap_or(false),
        suggested_folder: gpt_response.folder,
        confidence,
        reasoning: gpt_response.reasoning,
    })
}

/// Handle an OpenAI API response: check status, parse JSON, extract classification
async fn handle_api_response(response: reqwest::Response) -> Result<Classification, ClassifierError> {
    if !response.status().is_success() {
        let status = response.status();
        let _error_text = response.text().await.unwrap_or_default();
        return Err(ClassifierError::ApiStatus(status));
    }

    let api_response: OpenAIResponse = response
        .json()
        .await
        .map_err(ClassifierError::HttpClient)?;

    if api_response.choices.is_empty() {
        return Err(ClassifierError::NoChoices);
    }

    parse_response(&api_response.choices[0].message.content)
}

/// Send a text-based request to the OpenAI chat completions API and parse the response
async fn send_text_request(
    api_key: &str,
    prompt: String,
    timeout_secs: u64,
) -> Result<Classification, ClassifierError> {
    let request = TextRequest {
        model: "gpt-3.5-turbo".to_string(),
        messages: vec![TextMessage {
            role: "user".to_string(),
            content: prompt,
        }],
        temperature: 0.3,
    };

    rate_limit();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(ClassifierError::HttpClient)?;
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(ClassifierError::HttpClient)?;

    handle_api_response(response).await
}

/// Classify a file using filename only (GPT-3.5-turbo)
pub async fn classify_file(
    filename: String,
    available_folders: Vec<String>,
    correction_history: Vec<String>,
) -> Result<Classification, String> {
    let api_key = env::var("OPENAI_API_KEY")
        .map_err(|_| ClassifierError::MissingApiKey)?;

    let prompt = build_prompt(&filename, &available_folders, &correction_history, PromptMode::FilenameOnly);

    send_text_request(&api_key, prompt, API_TIMEOUT_SECS).await.map_err(|e| e.to_string())
}

/// Classify an image file using GPT-4o vision
///
/// Reads the image, base64-encodes it, and sends it to GPT-4o
/// so the AI can see the actual content (math, text, diagrams, etc.)
pub async fn classify_image_file(
    file_path: String,
    filename: String,
    available_folders: Vec<String>,
    correction_history: Vec<String>,
) -> Result<Classification, String> {
    classify_image_file_impl(file_path, filename, available_folders, correction_history)
        .await
        .map_err(|e| e.to_string())
}

async fn classify_image_file_impl(
    file_path: String,
    filename: String,
    available_folders: Vec<String>,
    correction_history: Vec<String>,
) -> Result<Classification, ClassifierError> {
    let api_key = env::var("OPENAI_API_KEY")
        .map_err(|_| ClassifierError::MissingApiKey)?;

    // Check file size before reading
    let metadata = std::fs::metadata(&file_path)
        .map_err(ClassifierError::FileRead)?;
    if metadata.len() > MAX_IMAGE_SIZE_BYTES {
        return Err(ClassifierError::ImageTooLarge {
            actual_mb: metadata.len() as f64 / (1024.0 * 1024.0),
            max_mb: MAX_IMAGE_SIZE_BYTES / (1024 * 1024),
        });
    }

    // Read and base64-encode the image
    let image_bytes = std::fs::read(&file_path)
        .map_err(ClassifierError::FileRead)?;

    let base64_data = base64::engine::general_purpose::STANDARD.encode(&image_bytes);

    // Determine MIME type from extension
    let mime_type = match file_path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png", // fallback
    };

    let prompt = build_prompt(&filename, &available_folders, &correction_history, PromptMode::Vision);

    let data_url = format!("data:{};base64,{}", mime_type, base64_data);

    let request = VisionRequest {
        model: "gpt-4o".to_string(),
        messages: vec![VisionMessage {
            role: "user".to_string(),
            content: vec![
                VisionContent::Text { text: prompt },
                VisionContent::ImageUrl {
                    image_url: ImageUrlData {
                        url: data_url,
                        detail: "low".to_string(), // low detail to reduce cost
                    },
                },
            ],
        }],
        temperature: 0.3,
        max_tokens: 300,
    };

    rate_limit();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(API_TIMEOUT_SECS * 2)) // Vision needs more time
        .build()
        .map_err(ClassifierError::HttpClient)?;
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(ClassifierError::HttpClient)?;

    handle_api_response(response).await
}

/// Extract text from a PDF file (first ~500 chars)
pub fn extract_pdf_text(file_path: &str) -> Result<String, String> {
    let bytes = std::fs::read(file_path)
        .map_err(|e| ClassifierError::FileRead(e).to_string())?;

    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| ClassifierError::PdfExtract(e.to_string()).to_string())?;

    // Take first ~500 chars, clean up whitespace
    let cleaned: String = text
        .chars()
        .take(500)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");

    Ok(cleaned)
}

// ============================================================
// TESTS
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_response tests ---

    #[test]
    fn test_parse_clean_json() {
        let content = r#"{"is_relevant": true, "folder": "C:\\Year2\\ML", "confidence": 0.95, "reasoning": "Machine learning lecture"}"#;
        let result = parse_response(content).unwrap();
        assert!(result.is_relevant);
        assert_eq!(result.suggested_folder, "C:\\Year2\\ML");
        assert!((result.confidence - 0.95).abs() < 0.001);
        assert_eq!(result.reasoning, "Machine learning lecture");
    }

    #[test]
    fn test_parse_markdown_json_block() {
        let content = "```json\n{\"is_relevant\": true, \"folder\": \"Math\", \"confidence\": 0.8, \"reasoning\": \"math notes\"}\n```";
        let result = parse_response(content).unwrap();
        assert!(result.is_relevant);
        assert_eq!(result.suggested_folder, "Math");
    }

    #[test]
    fn test_parse_generic_code_block() {
        let content = "```\n{\"is_relevant\": false, \"folder\": \"\", \"confidence\": 0.0, \"reasoning\": \"meme image\"}\n```";
        let result = parse_response(content).unwrap();
        assert!(!result.is_relevant);
        assert_eq!(result.suggested_folder, "");
        assert!((result.confidence - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_parse_missing_is_relevant_defaults_to_false() {
        let content = r#"{"folder": "Physics", "confidence": 0.9, "reasoning": "physics homework"}"#;
        let result = parse_response(content).unwrap();
        assert!(!result.is_relevant); // defaults to false when missing (safer)
        assert_eq!(result.suggested_folder, "Physics");
    }

    #[test]
    fn test_parse_invalid_json_returns_error() {
        let content = "not json at all";
        let result = parse_response(content);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Failed to parse GPT JSON response"));
    }

    #[test]
    fn test_parse_json_with_extra_whitespace() {
        let content = "  \n  {\"is_relevant\": true, \"folder\": \"CS\", \"confidence\": 0.75, \"reasoning\": \"code file\"}  \n  ";
        let result = parse_response(content).unwrap();
        assert!(result.is_relevant);
        assert_eq!(result.suggested_folder, "CS");
    }

    #[test]
    fn test_parse_json_with_text_before_code_block() {
        let content = "Here is the classification:\n```json\n{\"is_relevant\": true, \"folder\": \"OR\", \"confidence\": 0.85, \"reasoning\": \"operations research\"}\n```\nLet me know if you need more.";
        let result = parse_response(content).unwrap();
        assert_eq!(result.suggested_folder, "OR");
    }

    #[test]
    fn test_parse_zero_confidence_not_relevant() {
        let content = r#"{"is_relevant": false, "folder": "", "confidence": 0, "reasoning": "game installer"}"#;
        let result = parse_response(content).unwrap();
        assert!(!result.is_relevant);
        assert_eq!(result.confidence, 0.0);
    }

    #[test]
    fn test_parse_confidence_boundary_values() {
        // Confidence = 1.0
        let content = r#"{"is_relevant": true, "folder": "ML", "confidence": 1.0, "reasoning": "perfect match"}"#;
        let result = parse_response(content).unwrap();
        assert!((result.confidence - 1.0).abs() < 0.001);

        // Confidence = 0.5 (medium)
        let content = r#"{"is_relevant": true, "folder": "Math", "confidence": 0.5, "reasoning": "uncertain"}"#;
        let result = parse_response(content).unwrap();
        assert!((result.confidence - 0.5).abs() < 0.001);
    }

    // --- build_prompt tests ---

    #[test]
    fn test_build_prompt_filename_only() {
        let folders = vec!["ML".to_string(), "Physics".to_string()];
        let corrections: Vec<String> = vec![];
        let prompt = build_prompt("lecture_notes.pdf", &folders, &corrections, PromptMode::FilenameOnly);

        assert!(prompt.contains("Filename: lecture_notes.pdf"));
        assert!(prompt.contains("ML\nPhysics"));
        assert!(prompt.contains("Given a filename"));
        assert!(!prompt.contains("Extracted text content"));
        assert!(!prompt.contains("Look at the image content"));
    }

    #[test]
    fn test_build_prompt_vision_mode() {
        let folders = vec!["OR".to_string()];
        let corrections: Vec<String> = vec![];
        let prompt = build_prompt("screenshot.png", &folders, &corrections, PromptMode::Vision);

        assert!(prompt.contains("Look at the image content"));
        assert!(prompt.contains("Filename: screenshot.png"));
        assert!(!prompt.contains("Extracted text content"));
    }

    #[test]
    fn test_build_prompt_text_content_mode() {
        let folders = vec!["Math".to_string()];
        let corrections: Vec<String> = vec![];
        let text = "Integration by parts formula...".to_string();
        let prompt = build_prompt("tutorial3.pdf", &folders, &corrections, PromptMode::TextContent(text));

        assert!(prompt.contains("Extracted text content"));
        assert!(prompt.contains("Integration by parts formula"));
        assert!(prompt.contains("PRIORITIZE THIS for classification"));
        assert!(prompt.contains("based PRIMARILY on the extracted text content"));
    }

    #[test]
    fn test_build_prompt_with_corrections() {
        let folders = vec!["ML".to_string()];
        let corrections = vec![
            "\"romer_model.pdf\" → AI suggested ML, but user moved to Econ".to_string(),
        ];
        let prompt = build_prompt("test.pdf", &folders, &corrections, PromptMode::FilenameOnly);

        assert!(prompt.contains("Learn from these past corrections"));
        assert!(prompt.contains("romer_model.pdf"));
    }

    #[test]
    fn test_build_prompt_no_corrections() {
        let folders = vec!["ML".to_string()];
        let corrections: Vec<String> = vec![];
        let prompt = build_prompt("test.pdf", &folders, &corrections, PromptMode::FilenameOnly);

        assert!(!prompt.contains("Learn from these past corrections"));
    }

    #[test]
    fn test_build_prompt_empty_folders() {
        let folders: Vec<String> = vec![];
        let corrections: Vec<String> = vec![];
        let prompt = build_prompt("test.pdf", &folders, &corrections, PromptMode::FilenameOnly);

        assert!(prompt.contains("Available course folders:"));
        // Should still have the section, just empty
        assert!(prompt.contains("Filename: test.pdf"));
    }

    #[test]
    fn test_build_prompt_special_characters_in_filename() {
        let folders = vec!["ML".to_string()];
        let corrections: Vec<String> = vec![];
        let prompt = build_prompt("lecture (2) [final].pdf", &folders, &corrections, PromptMode::FilenameOnly);

        assert!(prompt.contains("Filename: lecture (2) [final].pdf"));
    }

    // --- Classification struct tests ---

    #[test]
    fn test_classification_serialization() {
        let c = Classification {
            is_relevant: true,
            suggested_folder: "ML".to_string(),
            confidence: 0.9,
            reasoning: "test".to_string(),
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"is_relevant\":true"));
        assert!(json.contains("\"suggested_folder\":\"ML\""));
    }

    #[test]
    fn test_classification_deserialization() {
        let json = r#"{"is_relevant": false, "suggested_folder": "", "confidence": 0.0, "reasoning": "not educational"}"#;
        let c: Classification = serde_json::from_str(json).unwrap();
        assert!(!c.is_relevant);
        assert_eq!(c.suggested_folder, "");
        assert_eq!(c.confidence, 0.0);
    }

    #[test]
    fn test_classification_clone() {
        let c = Classification {
            is_relevant: true,
            suggested_folder: "Physics".to_string(),
            confidence: 0.85,
            reasoning: "physics material".to_string(),
        };
        let c2 = c.clone();
        assert_eq!(c.suggested_folder, c2.suggested_folder);
        assert_eq!(c.confidence, c2.confidence);
    }

    // --- Edge case: GPT returns weird formats ---

    #[test]
    fn test_parse_json_with_integer_confidence() {
        // GPT sometimes returns confidence as integer 1 instead of 1.0
        let content = r#"{"is_relevant": true, "folder": "ML", "confidence": 1, "reasoning": "obvious"}"#;
        let result = parse_response(content).unwrap();
        assert!((result.confidence - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_parse_nested_markdown_blocks() {
        // Edge case: multiple code blocks, should take the first one after ```json
        let content = "Some text\n```json\n{\"is_relevant\": true, \"folder\": \"A\", \"confidence\": 0.7, \"reasoning\": \"first\"}\n```\nMore text\n```json\n{\"is_relevant\": true, \"folder\": \"B\", \"confidence\": 0.8, \"reasoning\": \"second\"}\n```";
        let result = parse_response(content).unwrap();
        assert_eq!(result.suggested_folder, "A"); // should pick the first one
    }

    #[test]
    fn test_parse_empty_reasoning() {
        let content = r#"{"is_relevant": true, "folder": "ML", "confidence": 0.6, "reasoning": ""}"#;
        let result = parse_response(content).unwrap();
        assert_eq!(result.reasoning, "");
    }

    #[test]
    fn test_parse_unicode_in_reasoning() {
        let content = r#"{"is_relevant": true, "folder": "Math", "confidence": 0.9, "reasoning": "Contains calculus formulas: ∫ and Σ"}"#;
        let result = parse_response(content).unwrap();
        assert!(result.reasoning.contains("∫"));
    }

    #[test]
    fn test_parse_folder_with_backslashes() {
        let content = r#"{"is_relevant": true, "folder": "C:\\Users\\student\\Year2\\ML", "confidence": 0.95, "reasoning": "ml notes"}"#;
        let result = parse_response(content).unwrap();
        assert_eq!(result.suggested_folder, "C:\\Users\\student\\Year2\\ML");
    }
}

/// Extract text from an image using Tesseract OCR
///
/// Returns the extracted text (first ~500 chars), or an error if OCR fails
pub fn extract_image_text(file_path: &str) -> Result<String, String> {
    let img = rusty_tesseract::Image::from_path(file_path)
        .map_err(|e| ClassifierError::OcrLoad(e.to_string()).to_string())?;

    let args = rusty_tesseract::Args {
        lang: "eng".to_string(),
        ..Default::default()
    };

    let text = rusty_tesseract::image_to_string(&img, &args)
        .map_err(|e| ClassifierError::OcrExtract(e.to_string()).to_string())?;

    // Clean up and take first ~500 chars
    let cleaned: String = text
        .chars()
        .take(500)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");

    Ok(cleaned)
}

/// Classify a file using extracted text content + filename (GPT-3.5-turbo)
///
/// Used as a second pass when filename-only classification has low confidence
pub async fn classify_with_text_content(
    filename: String,
    text_content: String,
    available_folders: Vec<String>,
    correction_history: Vec<String>,
) -> Result<Classification, String> {
    let api_key = env::var("OPENAI_API_KEY")
        .map_err(|_| ClassifierError::MissingApiKey)?;

    let prompt = build_prompt(
        &filename,
        &available_folders,
        &correction_history,
        PromptMode::TextContent(text_content),
    );

    send_text_request(&api_key, prompt, API_TIMEOUT_SECS).await.map_err(|e| e.to_string())
}
