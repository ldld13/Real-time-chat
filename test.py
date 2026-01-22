#!/usr/bin/env python3
"""Quick test script to call Zhipu (zai-sdk) and print candidate replies.

Usage:
  # set ZHIPU_API_KEY in environment, then:
  python test.py "退货"

If no argument is given the script will prompt for input.

This script intentionally reads the API key from environment variable
ZHIPU_API_KEY and does not hardcode any credentials.
"""
import os
import sys
import json
import time

MAX_RETRIES = 3
BASE_BACKOFF = 1.0

def call_with_retries(client, messages):
    """Call the client.chat.completions.create with simple retry/backoff for 429 errors."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = client.chat.completions.create(
                model="glm-4-flash",
                messages=messages,
                thinking={"type": "enabled"},
                max_tokens=1024,
                temperature=0.8
            )
            return resp, None
        except Exception as e:
            errstr = str(e)
            # detect 429-like concurrency/rate-limit errors
            if '429' in errstr or '并发' in errstr or '超' in errstr:
                if attempt < MAX_RETRIES:
                    backoff = BASE_BACKOFF * (2 ** (attempt - 1))
                    print(f"WARN: API returned rate-limit/concurrency error (attempt {attempt}/{MAX_RETRIES}). Retrying in {backoff}s...")
                    time.sleep(backoff)
                    continue
                else:
                    return None, e
            else:
                return None, e
    return None, Exception('unknown retry failure')


def main():
    key = os.environ.get('ZHIPU_API_KEY')
    if not key:
        print('ERROR: ZHIPU_API_KEY not set in environment. Set it and re-run.')
        return 2

    text = ' '.join(sys.argv[1:]).strip()
    if not text:
        try:
            text = input('输入要测试的用户片段: ').strip()
        except EOFError:
            print('No input provided')
            return 1
    if not text:
        print('No text to test. Exiting.')
        return 1

    try:
        from zai import ZhipuAiClient
    except Exception as e:
        print('ERROR: failed to import zai-sdk (pip install zai-sdk). Exception:', e)
        return 3

    client = None
    try:
        client = ZhipuAiClient(api_key=key)
    except Exception as e:
        print('ERROR: failed to create ZhipuAiClient:', e)
        return 4

    system = (
        "你是客服回复建议生成器。根据客户输入生成多样化的客服候选回复，覆盖不同语气（礼貌询问、道歉并提出解决方案、"
        "主动跟进、引导客户提供凭证、说明退款/换货流程等）。每条建议不超过 40 字。只输出候选文本，每条独立一行，最多输出 8 条，不要加入编号或额外说明。使用简体中文。"
    )

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": f"客户输入：\"{text}\""}
    ]

    resp, err = call_with_retries(client, messages)
    if err is not None:
        # If it's a rate-limit error provide actionable advice
        estr = str(err)
        if '429' in estr or '并发' in estr or '超' in estr:
            print('ERROR: API returned a rate-limit/concurrency error (429).')
            print('建议:')
            print('- 稍等几秒再试；')
            print('- 减少并发请求（仅在用户显式请求时调用）；')
            print('- 联系智谱平台客服提升配额或使用独立企业账号。')
        else:
            print('ERROR: API call failed:', err)
        return 5

    # parse response robustly
    output = []
    try:
        # try structured access
        msg = resp.choices[0].message
        if isinstance(msg, str):
            raw = msg
        else:
            raw = getattr(msg, 'content', str(msg))
    except Exception:
        raw = str(resp)

    # split into lines and further by punctuation if necessary
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    if not lines:
        import re
        parts = re.split(r'[。！？;；\n]+', raw)
        lines = [p.strip() for p in parts if p.strip()]

    seen = set()
    for p in lines:
        if p not in seen:
            output.append(p)
            seen.add(p)
        if len(output) >= 8:
            break

    print(json.dumps({
        'input': text,
        'suggestions': output,
        'raw': raw
    }, ensure_ascii=False, indent=2))
    return 0

if __name__ == '__main__':
    sys.exit(main())
