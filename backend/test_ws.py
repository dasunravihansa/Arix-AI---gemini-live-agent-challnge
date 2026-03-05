import asyncio
import websockets

async def test():
    async with websockets.connect("ws://localhost:8000/ws/live") as ws:
        print("Connected")
        await ws.recv()

asyncio.run(test())
