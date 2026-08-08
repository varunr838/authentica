import time
from sqlalchemy import Column, String, BigInteger, Float
from sqlalchemy.dialects.postgresql import UUID
import uuid

from database.database import Base

class Job(Base):
    __tablename__ = "jobs"

    job_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    
    video_hash = Column(String, unique=True, index=True, nullable=True)
    
    status = Column(String, nullable=False, default="pending")
    
    raw_path = Column(String, nullable=True)
    blurred_path = Column(String, nullable=True)
    proof_path = Column(String, nullable=True)
    
    tx_hash = Column(String, nullable=True)
    gas_used = Column(BigInteger, nullable=True)
    block_number = Column(BigInteger, nullable=True)
    
    error_message = Column(String, nullable=True)
    created_at = Column(Float, default=time.time)
    updated_at = Column(Float, default=time.time, onupdate=time.time)