import asyncio
import pathlib
import sys
import traceback
from video_processor import process_video_async
from blockchain_publisher import publish_async

async def main():
    vid_path = pathlib.Path("uploads/23251157-4463-4ec2-a2df-90e63e5e27ba.mp4")
    print("Running process_video_async...")
    try:
        res1 = await process_video_async(vid_path, "test_job")
        print("Process Result:", res1)
        
        print("Running publish_async...")
        res2 = await publish_async(pathlib.Path(res1["proof_json"]), pathlib.Path(res1["blurred_video"]))
        print("Publish Result:", res2)
    except Exception as e:
        traceback.print_exc()

asyncio.run(main())
