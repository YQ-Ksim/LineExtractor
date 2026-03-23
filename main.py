import numpy as np
import cv2
import matplotlib.pyplot as plt


# ========== 基础工具 ==========
def load_image(path):
    img = cv2.imread(path)
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    return img


def split_rgb(img):
    return img[:, :, 0], img[:, :, 1], img[:, :, 2]


def normalize(img):
    img = img - np.min(img)
    img = img / (np.max(img) + 1e-8)
    return img


# ========== Sigmoid增强 ==========
def sigmoid_enhance(img, k=10, x0=0.5):
    img = normalize(img)
    return 1 / (1 + np.exp(-k * (img - x0)))


# ========== Butterworth高通 ==========
def butterworth_highpass(shape, cutoff, order=2):
    rows, cols = shape
    crow, ccol = rows // 2, cols // 2

    H = np.zeros((rows, cols))
    for u in range(rows):
        for v in range(cols):
            D = np.sqrt((u - crow) ** 2 + (v - ccol) ** 2)
            if D == 0:
                H[u, v] = 0
            else:
                H[u, v] = 1 / (1 + (cutoff / D) ** (2 * order))
    return H


# ========== 理想硬截断高通 ==========
def ideal_highpass(shape, cutoff):
    rows, cols = shape
    crow, ccol = rows // 2, cols // 2

    H = np.ones((rows, cols))
    for u in range(rows):
        for v in range(cols):
            D = np.sqrt((u - crow) ** 2 + (v - ccol) ** 2)
            if D < cutoff:
                H[u, v] = 0
    return H


# ========== FFT高通 ==========
def highpass_fft(img, cutoff, mode="butterworth"):
    f = np.fft.fft2(img)
    fshift = np.fft.fftshift(f)

    if mode == "butterworth":
        H = butterworth_highpass(img.shape, cutoff)
    else:
        H = ideal_highpass(img.shape, cutoff)

    G = fshift * H
    img_back = np.fft.ifft2(np.fft.ifftshift(G))
    return np.abs(img_back)


# ========== K算法 ==========
def compute_K(R, G, B):
    numerator = R * R + G * G + B * B
    denominator = 256 * (R + G + B + 1e-8)
    return numerator / denominator


# ========== 主流程 ==========
def process_with_R(img, R, mode="butterworth"):
    r, g, b = split_rgb(img)

    r_edge = highpass_fft(r, R, mode)
    g_edge = highpass_fft(g, R, mode)
    b_edge = highpass_fft(b, R, mode)

    K = compute_K(r_edge, g_edge, b_edge)
    sigmoid = sigmoid_enhance(K)

    return r_edge, g_edge, b_edge, K, sigmoid


# ========== 可视化 ==========
def visualize(img):
    Rs = [10, 20, 40, 60, 80, 120]

    plt.figure(figsize=(12, 12))

    for i, R in enumerate(Rs):
        r_edge, g_edge, b_edge, K, sigmoid = process_with_R(img, R, mode="butterworth")

        row = i

        plt.subplot(6, 6, row * 6 + 1)
        plt.imshow(img)
        plt.axis("off")
        if row == 0:
            plt.title("Original")

        plt.subplot(6, 6, row * 6 + 2)
        plt.imshow(r_edge, cmap='gray')
        plt.axis("off")
        if row == 0:
            plt.title("R Edge")

        plt.subplot(6, 6, row * 6 + 3)
        plt.imshow(g_edge, cmap='gray')
        plt.axis("off")
        if row == 0:
            plt.title("G Edge")

        plt.subplot(6, 6, row * 6 + 4)
        plt.imshow(b_edge, cmap='gray')
        plt.axis("off")
        if row == 0:
            plt.title("B Edge")

        plt.subplot(6, 6, row * 6 + 5)
        plt.imshow(K, cmap='gray')
        plt.axis("off")
        if row == 0:
            plt.title("K")

        plt.subplot(6, 6, row * 6 + 6)
        plt.imshow(sigmoid, cmap='gray')
        plt.axis("off")
        if row == 0:
            plt.title("Sigmoid")

    plt.tight_layout()
    plt.show()


# ========== 主程序 ==========
if __name__ == "__main__":
    img = load_image("test.jpg")
    visualize(img)