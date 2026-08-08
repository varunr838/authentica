import asyncio, httpx
async def main():
    async with httpx.AsyncClient() as client:
        with open("uploads/23251157-4463-4ec2-a2df-90e63e5e27ba.mp4", "rb") as f:
            r1 = await client.post("http://localhost:8000/upload", files={"file": f})
        job_id = r1.json()["job_id"]
        print("Job ID:", job_id)
        r2 = await client.post(f"http://localhost:8000/process/{job_id}?publish=true")
        print("Process:", r2.json())
        while True:
            r3 = await client.get(f"http://localhost:8000/status/{job_id}")
            data = r3.json()
            print(data["status"], data.get("error"))
            if data["status"] in ("done", "failed"):
                break
            await asyncio.sleep(1)
asyncio.run(main())
