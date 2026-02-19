# agent/retry_queue.py
"""
Retry queue for locked files with exponential backoff
"""
import time


class LockedFileQueue:
    """
    Manages locked files with retry logic
    
    Features:
    - Exponential backoff (5s, 10s, 20s, 40s, 60s max)
    - Max 5 retry attempts
    - Tracks last retry time
    """
    
    def __init__(self, max_retries=5):
        self.max_retries = max_retries
        self.queue = {}  # {file_path: {'folder': str, 'attempts': int, 'last_retry': float, 'user_choice': dict}}
    
    def add(self, file_path, folder, user_choice=None):
        """Add a locked file to retry queue"""
        self.queue[file_path] = {
            'folder': folder,
            'attempts': 0,
            'last_retry': time.time(),
            'user_choice': user_choice  # Store accept/choose/ignore decision
        }
    
    def get_ready_files(self):
        """
        Get files ready for retry based on exponential backoff
        
        Returns:
            list: [(file_path, folder, user_choice)]
        """
        now = time.time()
        ready = []
        
        for file_path, data in list(self.queue.items()):
            attempts = data['attempts']
            last_retry = data['last_retry']
            
            # Exponential backoff: 5, 10, 20, 40, 60 seconds
            wait_time = min(5 * (2 ** attempts), 60)
            
            if now - last_retry >= wait_time:
                ready.append((file_path, data['folder'], data['user_choice']))
        
        return ready
    
    def mark_retry(self, file_path):
        """Mark file as retried (increment attempt counter)"""
        if file_path in self.queue:
            self.queue[file_path]['attempts'] += 1
            self.queue[file_path]['last_retry'] = time.time()
    
    def remove(self, file_path):
        """Remove file from queue (success or max retries)"""
        if file_path in self.queue:
            del self.queue[file_path]
    
    def should_give_up(self, file_path):
        """Check if max retries reached"""
        if file_path in self.queue:
            return self.queue[file_path]['attempts'] >= self.max_retries
        return False
    
    def size(self):
        """Get queue size"""
        return len(self.queue)
    
    def list_all(self):
        """List all files in queue with status"""
        return [
            {
                'file': file_path,
                'folder': data['folder'],
                'attempts': data['attempts'],
                'max_retries': self.max_retries
            }
            for file_path, data in self.queue.items()
        ]
