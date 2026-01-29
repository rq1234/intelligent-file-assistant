"""
Decision engine for determining file destinations
"""
from pathlib import Path


class DecisionEngine:
    """Makes decisions about where files should be organized"""
    
    def __init__(self, settings):
        """
        Initialize the decision engine
        
        Args:
            settings: Configuration settings
        """
        self.settings = settings
        self.target_dirs = settings.get('target_directories', {})
        self.file_types = settings.get('file_types', {})
    
    def decide(self, features, content):
        """
        Decide where a file should be moved
        
        Args:
            features: Dictionary of file features
            content: Text content of the file
            
        Returns:
            dict: Decision with target_path and confidence
        """
        extension = features.get('extension', '')
        
        # Find category based on extension
        category = self._get_category(extension)
        
        if category and category in self.target_dirs:
            target_base = Path(self.target_dirs[category]).expanduser()
            target_path = target_base / features['name']
            
            return {
                'target_path': str(target_path),
                'category': category,
                'confidence': 0.8,
                'reason': f'File extension matches {category} category'
            }
        
        return None
    
    def _get_category(self, extension):
        """Get the category for a file extension"""
        for category, extensions in self.file_types.items():
            if extension in extensions:
                return category
        return None
    
    def decide_with_ai(self, features, content):
        """
        Use AI to make a decision (placeholder for future implementation)
        
        Args:
            features: Dictionary of file features
            content: Text content of the file
            
        Returns:
            dict: Decision with target_path and confidence
        """
        # TODO: Implement AI-based decision making using OpenAI API
        # This would analyze the content and context to make smarter decisions
        pass
