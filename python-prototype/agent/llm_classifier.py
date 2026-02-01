"""
LLM-based intelligent file classification using OpenAI
"""
import os
import json
import yaml
from openai import OpenAI
from features.content_extractors import extract_title, extract_image_text, is_image
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()


def load_settings():
    """Load settings from config/settings.yaml"""
    with open("config/settings.yaml", "r") as f:
        return yaml.safe_load(f)


def get_file_content_summary(file_path, max_chars=500):
    """
    Extract a summary of file content for LLM analysis

    Args:
        file_path: Path to the file
        max_chars: Maximum characters to extract

    Returns:
        str: Content summary or empty string
    """
    try:
        if is_image(file_path):
            content = extract_image_text(file_path)
        else:
            content = extract_title(file_path)

        if content:
            # Truncate to reasonable length for LLM
            return content[:max_chars]
        return ""
    except Exception as e:
        print(f"[DEBUG] Could not extract content: {e}")
        return ""


def llm_classify(file_path, available_folders):
    """
    Use OpenAI LLM to intelligently classify a file

    Args:
        file_path: Path to the file to classify
        available_folders: List of available folder paths

    Returns:
        dict: {
            "folder": str (best matching folder path or None),
            "confidence": float (0-1),
            "reasoning": str (explanation),
            "method": "llm"
        }

        Returns None if LLM classification fails (triggers fallback)
    """
    try:
        settings = load_settings()
        ai_config = settings.get("ai", {})

        # Check if LLM is enabled
        if not ai_config.get("enabled", True):
            return None

        # Try environment variable first, then fall back to settings.yaml
        api_key = os.getenv("OPENAI_API_KEY") or ai_config.get("openai_api_key")
        if not api_key or api_key == "YOUR_OPENAI_API_KEY_HERE":
            print("[WARN] OpenAI API key not found. Set OPENAI_API_KEY env var or update config/settings.yaml")
            return None

        # Initialize OpenAI client
        client = OpenAI(api_key=api_key)

        # Extract file information
        filename = os.path.basename(file_path)
        content_summary = get_file_content_summary(file_path)

        # Prepare folder list (extract just folder names for cleaner prompt)
        folder_names = [os.path.basename(folder) for folder in available_folders]

        # Build prompt
        prompt = f"""You are a file organization assistant for an Imperial College student.

Analyze this file and determine which folder it belongs to.

Filename: {filename}
Content summary: {content_summary if content_summary else "No extractable content"}

Available folders:
{chr(10).join(f"- {name}" for name in folder_names)}

Which folder best fits this file? Consider:
- Academic subject matter (e.g., Integer Programming → Operations Research)
- Course names and topics
- File content and context

Respond ONLY with valid JSON in this exact format:
{{
  "folder": "folder_name_here",
  "confidence": 85,
  "reasoning": "Brief explanation"
}}

Rules:
- confidence must be 0-100 (integer)
- folder must exactly match one of the available folders
- If no good match exists, use confidence < 40"""

        # Call OpenAI API
        response = client.chat.completions.create(
            model=ai_config.get("model", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": "You are a precise file classification assistant. Always respond with valid JSON."},
                {"role": "user", "content": prompt}
            ],
            temperature=ai_config.get("temperature", 0.3),
            max_tokens=ai_config.get("max_tokens", 200)
        )

        # Parse response
        response_text = response.choices[0].message.content.strip()

        # Extract JSON from response (handle markdown code blocks)
        if "```json" in response_text:
            response_text = response_text.split("```json")[1].split("```")[0].strip()
        elif "```" in response_text:
            response_text = response_text.split("```")[1].split("```")[0].strip()

        result = json.loads(response_text)

        # Validate response
        suggested_folder_name = result.get("folder")
        confidence_pct = result.get("confidence", 0)
        reasoning = result.get("reasoning", "No explanation provided")

        # Convert percentage to 0-1 range
        confidence = confidence_pct / 100.0

        # Find matching folder path
        matched_folder = None
        for folder_path in available_folders:
            if os.path.basename(folder_path) == suggested_folder_name:
                matched_folder = folder_path
                break

        if not matched_folder:
            print(f"[WARN] LLM suggested unknown folder: {suggested_folder_name}")
            return None

        print(f"[LLM] {filename} -> {suggested_folder_name} ({confidence_pct}%)")
        print(f"      Reasoning: {reasoning}")

        return {
            "folder": matched_folder,
            "confidence": confidence,
            "reasoning": reasoning,
            "method": "llm"
        }

    except json.JSONDecodeError as e:
        print(f"[ERROR] LLM returned invalid JSON: {e}")
        print(f"[ERROR] Response was: {response_text if 'response_text' in locals() else 'N/A'}")
        return None
    except Exception as e:
        print(f"[ERROR] LLM classification failed: {e}")
        return None


def classify_file(file_path, available_folders):
    """
    Main classification function - tries LLM first, falls back to None

    Args:
        file_path: Path to file
        available_folders: List of available folder paths

    Returns:
        dict or None: Classification result or None (triggers fallback in matcher)
    """
    return llm_classify(file_path, available_folders)
