import { checkedTextResourceLicense, type TextResourceLicense } from '@studio/spec';

// Keep the unchanged legacy notice so adding a sharing option never rewrites old private revisions or their hashes.
export const PRIVATE_TEXT_NOTICE = 'LicenseRef-Proprietary\n개인 작업을 위한 자료입니다. 공개 재배포 권한을 부여하지 않습니다. 별도 허락 없이 다른 사용자에게 배포하지 마세요.\n';
const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** Only explicit per-resource terms change a new resource's license; the service's MIT license is never inferred. */
export function textResourceNotice(value?: TextResourceLicense): { id: string; text: string } {
  if (value === undefined) return { id: 'LicenseRef-Proprietary', text: PRIVATE_TEXT_NOTICE };
  const license = checkedTextResourceLicense(value);
  return { id: 'MIT', text: `MIT License\n\nCopyright (c) ${license.copyrightYear} ${license.copyrightHolder}\n\n${MIT_TERMS}` };
}
