"""
File matcher that coordinates the organization process
"""
from pathlib import Path
from features.file_features import extract_file_features
from features.content_extractors import extract_text_content
from actions.mover import move_file


class FileMatcher:
    """Coordinates file analysis and organization"""
    
    def __init__(self, decision_engine, store):
        """
        Initialize the file matcher
        
        Args:
            decision_engine: DecisionEngine instance
            store: LocalStore instance for persistence
        """
        self.decision_engine = decision_engine
        self.store = store
    
    def process_file(self, file_path):
        """
        Process a file and organize it
        
        Args:
            file_path: Path to the file to process
        """
        try:
            path = Path(file_path)
            
            if not path.exists():
                print(f"File does not exist: {path}")
                return
            
            print(f"Processing file: {path}")
            
            # Extract features
            features = extract_file_features(path)
            content = extract_text_content(path)
            
            # Get decision from AI
            decision = self.decision_engine.decide(features, content)
            
            if decision and decision.get('target_path'):
                target = Path(decision['target_path'])
                confidence = decision.get('confidence', 0)
                
                print(f"Decision: Move to {target} (confidence: {confidence:.2f})")
                
                # Execute the move
                if confidence > 0.5:  # Only move if confidence is high enough
                    success = move_file(path, target, self.store)
                    if success:
                        print(f"Successfully moved file to: {target}")
                    else:
                        print(f"Failed to move file")
                else:
                    print(f"Confidence too low, skipping move")
            else:
                print("No suitable destination found")
                
        except Exception as e:
            print(f"Error processing file {file_path}: {e}")
