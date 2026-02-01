# agent/batch.py
"""
Batch manager with two-window system:
- Window A: Debounce (2-3 sec) - file completeness
- Window B: Batch (8 sec) - grouping related downloads
"""
import time


class BatchManager:
    """
    Manages file batching with explicit rules:
    
    Rule 1: When file arrives
    - add to batch queue
    - set T_last = now
    
    Rule 2: When to close batch
    - batch closes when: T_now - T_last >= BATCH_WINDOW_SECONDS
    - triggers processing (either single or batch flow)
    """
    
    def __init__(self, window_seconds=8):
        """
        Args:
            window_seconds: Batch grouping window (default 8 sec - empirically optimal)
        """
        self.window = window_seconds
        self.files = []
        self.t_last = None  # Time last file was added

    def add_file(self, file_path):
        """Rule 1: Add file to batch and update timestamp"""
        self.files.append(file_path)
        self.t_last = time.time()

    def is_ready(self):
        """Rule 2: Check if batch should close"""
        if not self.files or not self.t_last:
            return False
        
        t_now = time.time()
        elapsed = t_now - self.t_last
        
        # Batch closes when window elapsed
        return elapsed >= self.window

    def pop_batch(self):
        """Extract batch and reset state"""
        batch = self.files[:]
        self.files.clear()
        self.t_last = None
        return batch
    
    def is_single(self):
        """Check if current batch has only 1 file (Case A)"""
        return len(self.files) == 1
