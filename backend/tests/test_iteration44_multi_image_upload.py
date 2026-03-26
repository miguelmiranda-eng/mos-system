"""
Test iteration 44: Multi-image upload in comments
Tests:
- POST /api/orders/{order_id}/images: accepts base64 image_data and returns url + filename
- POST /api/orders/{order_id}/comments: accepts content with [img]url[/img] tags
- GET /api/orders/{order_id}/comments: returns comments with image content
- Multiple sequential image uploads to same order
"""
import pytest
import requests
import os
import base64

# Backend URL from environment
BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

# Test session token and order ID - will be set in fixtures
TEST_SESSION_TOKEN = "test_session_img_1773333214341"
TEST_ORDER_ID = "order_1e94f2771ec5"

# Simple 1x1 pixel PNG in base64 (smallest valid PNG)
SMALL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
# Same with data URI prefix
SMALL_PNG_DATA_URI = f"data:image/png;base64,{SMALL_PNG_BASE64}"

# Another simple PNG for testing multiple uploads
SMALL_RED_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="


class TestImageUpload:
    """Tests for image upload endpoint POST /api/orders/{order_id}/images"""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test session"""
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TEST_SESSION_TOKEN}"
        })

    def test_image_upload_with_base64_data(self):
        """Test uploading image with raw base64 data (no data URI prefix)"""
        response = self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
            json={
                "image_data": SMALL_PNG_BASE64,
                "filename": "test_raw_base64.png"
            }
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        # Verify response structure
        assert "url" in data, "Response should contain 'url'"
        assert "filename" in data, "Response should contain 'filename'"
        assert data["filename"] == "test_raw_base64.png"
        assert "test_raw_base64.png" in data["url"]
        print(f"✓ Image uploaded successfully: {data['url']}")

    def test_image_upload_with_data_uri(self):
        """Test uploading image with data URI prefix (data:image/png;base64,...)"""
        response = self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
            json={
                "image_data": SMALL_PNG_DATA_URI,
                "filename": "test_data_uri.png"
            }
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        assert "url" in data
        assert "filename" in data
        assert data["filename"] == "test_data_uri.png"
        print(f"✓ Image with data URI uploaded: {data['url']}")

    def test_image_upload_auto_filename(self):
        """Test uploading image without filename (auto-generated)"""
        response = self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
            json={
                "image_data": SMALL_PNG_BASE64
            }
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        assert "url" in data
        assert "filename" in data
        assert data["filename"].endswith(".png")
        print(f"✓ Auto-generated filename: {data['filename']}")

    def test_image_upload_missing_image_data(self):
        """Test error when image_data is missing"""
        response = self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
            json={
                "filename": "no_data.png"
            }
        )
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        data = response.json()
        assert "image_data required" in data.get("detail", "")
        print("✓ Correctly rejected request without image_data")

    def test_image_upload_invalid_order(self):
        """Test error when order doesn't exist"""
        response = self.session.post(
            f"{BASE_URL}/api/orders/invalid_order_id/images",
            json={
                "image_data": SMALL_PNG_BASE64,
                "filename": "test.png"
            }
        )
        
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        print("✓ Correctly returned 404 for invalid order")


class TestMultipleSequentialUploads:
    """Test uploading multiple images sequentially to same order (simulates multi-image comment)"""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test session"""
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TEST_SESSION_TOKEN}"
        })

    def test_sequential_multi_image_upload(self):
        """Test uploading 3 images sequentially to same order (simulates frontend multi-upload)"""
        image_urls = []
        
        # Upload 3 different images sequentially
        test_images = [
            {"data": SMALL_PNG_BASE64, "filename": "multi_img_1.png"},
            {"data": SMALL_RED_PNG_BASE64, "filename": "multi_img_2.png"},
            {"data": SMALL_PNG_BASE64, "filename": "multi_img_3.png"}
        ]
        
        for img in test_images:
            response = self.session.post(
                f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
                json={
                    "image_data": img["data"],
                    "filename": img["filename"]
                }
            )
            
            assert response.status_code == 200, f"Upload failed for {img['filename']}: {response.text}"
            data = response.json()
            image_urls.append(data["url"])
            print(f"✓ Uploaded {img['filename']}: {data['url']}")
        
        # Verify all 3 images were uploaded successfully
        assert len(image_urls) == 3, "Should have 3 image URLs"
        
        # All URLs should be unique
        assert len(set(image_urls)) == 3, "All image URLs should be unique"
        
        print(f"✓ Successfully uploaded {len(image_urls)} images sequentially")
        return image_urls


class TestCommentsWithImages:
    """Test comments endpoint with [img] tags"""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test session"""
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TEST_SESSION_TOKEN}"
        })

    def test_create_comment_with_single_image(self):
        """Test creating comment with single [img] tag"""
        # First upload an image
        upload_res = self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
            json={
                "image_data": SMALL_PNG_BASE64,
                "filename": "comment_single.png"
            }
        )
        assert upload_res.status_code == 200
        img_url = upload_res.json()["url"]
        
        # Create comment with [img] tag
        comment_content = f"Here is a single image:\n[img]{img_url}[/img]"
        comment_res = self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/comments",
            json={
                "content": comment_content
            }
        )
        
        assert comment_res.status_code == 200, f"Comment creation failed: {comment_res.text}"
        comment_data = comment_res.json()
        
        assert "comment_id" in comment_data
        assert "[img]" in comment_data["content"]
        assert img_url in comment_data["content"]
        print(f"✓ Created comment with single image: {comment_data['comment_id']}")
        return comment_data["comment_id"]

    def test_create_comment_with_multiple_images(self):
        """Test creating comment with multiple [img] tags (simulates drag & drop multi-upload)"""
        # Upload 3 images
        image_urls = []
        for i in range(3):
            upload_res = self.session.post(
                f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
                json={
                    "image_data": SMALL_PNG_BASE64,
                    "filename": f"comment_multi_{i+1}.png"
                }
            )
            assert upload_res.status_code == 200
            image_urls.append(upload_res.json()["url"])
        
        # Create comment with multiple [img] tags (this is how frontend sends it)
        img_tags = "\n".join([f"[img]{url}[/img]" for url in image_urls])
        comment_content = f"Test comment with multiple images:\n{img_tags}"
        
        comment_res = self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/comments",
            json={
                "content": comment_content
            }
        )
        
        assert comment_res.status_code == 200, f"Comment creation failed: {comment_res.text}"
        comment_data = comment_res.json()
        
        # Verify all image URLs are in the comment content
        for url in image_urls:
            assert url in comment_data["content"], f"Image URL {url} not found in comment content"
        
        # Count [img] tags - should be 3
        img_tag_count = comment_data["content"].count("[img]")
        assert img_tag_count == 3, f"Expected 3 [img] tags, found {img_tag_count}"
        
        print(f"✓ Created comment with {img_tag_count} images: {comment_data['comment_id']}")
        return comment_data["comment_id"]

    def test_get_comments_returns_image_content(self):
        """Test that GET comments returns content with [img] tags intact"""
        # First create a comment with images
        upload_res = self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
            json={
                "image_data": SMALL_PNG_BASE64,
                "filename": "get_test_img.png"
            }
        )
        assert upload_res.status_code == 200
        img_url = upload_res.json()["url"]
        
        comment_content = f"Test GET endpoint\n[img]{img_url}[/img]"
        self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/comments",
            json={"content": comment_content}
        )
        
        # GET comments
        get_res = self.session.get(f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/comments")
        
        assert get_res.status_code == 200, f"GET comments failed: {get_res.text}"
        comments = get_res.json()
        
        assert isinstance(comments, list), "Response should be a list"
        assert len(comments) > 0, "Should have at least one comment"
        
        # Find comment with our test image
        found_img_comment = False
        for comment in comments:
            if "[img]" in comment.get("content", ""):
                found_img_comment = True
                print(f"✓ Found comment with image: {comment['comment_id']}")
                break
        
        assert found_img_comment, "Should find at least one comment with [img] tag"
        print(f"✓ GET endpoint returns {len(comments)} comments with image content preserved")


class TestUploadsDirectory:
    """Test uploads directory exists and is writable"""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test session"""
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TEST_SESSION_TOKEN}"
        })

    def test_uploaded_file_accessible(self):
        """Test that uploaded files can be accessed via /api/uploads/"""
        # Upload a test image
        response = self.session.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
            json={
                "image_data": SMALL_PNG_BASE64,
                "filename": "access_test.png"
            }
        )
        
        assert response.status_code == 200
        img_url = response.json()["url"]
        
        # URL may be relative (/api/uploads/...) or absolute (https://...)
        # Build full URL if relative
        if img_url.startswith("/"):
            full_url = f"{BASE_URL}{img_url}"
        else:
            full_url = img_url
        
        # Try to access the uploaded file (without auth as uploads are public)
        file_res = requests.get(full_url)
        
        # Should be accessible
        assert file_res.status_code == 200, f"File not accessible: {file_res.status_code}"
        assert len(file_res.content) > 0, "File should have content"
        print(f"✓ Uploaded file accessible at: {full_url}")


class TestAuthenticationRequired:
    """Test that image upload requires authentication"""

    def test_upload_without_auth_fails(self):
        """Test that upload without auth token fails"""
        response = requests.post(
            f"{BASE_URL}/api/orders/{TEST_ORDER_ID}/images",
            json={
                "image_data": SMALL_PNG_BASE64,
                "filename": "no_auth.png"
            },
            headers={"Content-Type": "application/json"}
        )
        
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("✓ Upload correctly requires authentication")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
