package com.pocket.calendar

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

data class InstalledAppInfo(
    val versionName: String,
    val versionCode: Long,
    val canInstallUpdates: Boolean
)

data class UpdateInstallSpec(
    val downloadUrl: String,
    val bearerToken: String,
    val expectedSha256: String,
    val versionName: String
)

data class UpdateInstallOutcome(
    val status: String,
    val sha256: String = ""
)

object AppUpdateInstaller {
    private const val UPDATES_SUBDIR = "updates"
    private const val APK_MIME = "application/vnd.android.package-archive"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 60_000
    private const val MAX_APK_BYTES = 80L * 1024L * 1024L

    fun getInstalledInfo(context: Context): InstalledAppInfo {
        val pm = context.packageManager
        val pkg = pm.getPackageInfo(context.packageName, 0)
        val verName = pkg.versionName ?: "0.0.0"
        val verCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pkg.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            pkg.versionCode.toLong()
        }
        return InstalledAppInfo(verName, verCode, canInstallPackages(context))
    }

    fun canInstallPackages(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return true
        }
        return context.packageManager.canRequestPackageInstalls()
    }

    fun openInstallPermissionSettings(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val uri = Uri.parse("package:${context.packageName}")
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, uri)
            .apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        context.startActivity(intent)
    }

    fun downloadAndInstall(
        context: Context,
        spec: UpdateInstallSpec
    ): UpdateInstallOutcome {
        if (!canInstallPackages(context)) {
            openInstallPermissionSettings(context)
            return UpdateInstallOutcome("PERMISSION_REQUIRED")
        }
        val safeVer = sanitizeVersion(spec.versionName)
        val dir = File(context.cacheDir, UPDATES_SUBDIR).apply { mkdirs() }
        pruneOldApks(dir)
        val tmpFile = File(dir, "pocket-calendar-$safeVer.tmp")
        val apkFile = File(dir, "pocket-calendar-$safeVer.apk")
        val actualSha = streamDownloadAndHash(spec, tmpFile)
        val expected = spec.expectedSha256.trim().lowercase()
        if (expected.isNotEmpty() && actualSha != expected) {
            tmpFile.delete()
            throw SecurityException("APK SHA-256 verification failed")
        }
        if (apkFile.exists()) {
            apkFile.delete()
        }
        if (!tmpFile.renameTo(apkFile)) {
            tmpFile.delete()
            throw IllegalStateException("Failed to stage downloaded APK")
        }
        launchSystemInstaller(context, apkFile)
        return UpdateInstallOutcome("INSTALLER_LAUNCHED", actualSha)
    }

    private fun sanitizeVersion(raw: String): String {
        val cleaned = raw.replace(Regex("[^A-Za-z0-9._-]"), "")
        return cleaned.ifEmpty { "latest" }
    }

    private fun pruneOldApks(dir: File) {
        dir.listFiles()?.forEach { file ->
            if (file.isFile) {
                file.delete()
            }
        }
    }

    private fun streamDownloadAndHash(
        spec: UpdateInstallSpec,
        dest: File
    ): String {
        val conn = (URL(spec.downloadUrl).openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                if (spec.bearerToken.isNotBlank()) {
                    setRequestProperty(
                        "Authorization",
                        "Bearer ${spec.bearerToken}"
                    )
                }
            }
        try {
            val code = conn.responseCode
            if (code !in 200..299) {
                throw IllegalStateException("APK download failed: HTTP $code")
            }
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            conn.inputStream.use { input ->
                FileOutputStream(dest).use { output ->
                    val buf = ByteArray(16 * 1024)
                    while (true) {
                        val read = input.read(buf)
                        if (read <= 0) break
                        total += read
                        if (total > MAX_APK_BYTES) {
                            throw IllegalStateException("APK exceeds 80MB")
                        }
                        digest.update(buf, 0, read)
                        output.write(buf, 0, read)
                    }
                }
            }
            if (total <= 0L) {
                throw IllegalStateException("Downloaded APK is empty")
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        } catch (err: Exception) {
            dest.delete()
            throw err
        } finally {
            conn.disconnect()
        }
    }

    private fun launchSystemInstaller(context: Context, apkFile: File) {
        val authority = "${context.packageName}.fileprovider"
        val contentUri = FileProvider.getUriForFile(context, authority, apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(contentUri, APK_MIME)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(intent)
    }
}
